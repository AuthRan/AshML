/**
 * A PNG decoder, and the two transforms that turn any image into what a model expects.
 *
 * This exists because `ash predict --image cat.png` has to send pixels, and the model
 * server takes 32x32x3 values in 0..255 rather than a file — deliberately, so that the
 * normalisation the weights were trained with is applied in exactly one place, by the
 * server that owns those weights. Decoding therefore happens on the client.
 *
 * It is written by hand rather than pulled in, for the same reason the SDK has no
 * dependencies: `ash` is a tool people install to talk to a control plane, and an image
 * library is a large amount of native code to carry for the one command that shows a
 * prediction. Node already ships the hard part — zlib — and the rest of the format that
 * matters here is a header, a filter per scanline, and a palette.
 *
 * What it does not do is the whole specification: interlaced images and 1/2/4-bit
 * depths are refused by name rather than half-decoded. A wrong image silently produces a
 * confident prediction about nothing, so every path that cannot be handled correctly
 * says so instead.
 */

import zlib from 'node:zlib';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Channels per pixel, by PNG colour type. Types 1 and 5 do not exist. */
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

const COLOUR_NAMES = {
  0: 'greyscale', 2: 'truecolour', 3: 'indexed', 4: 'greyscale+alpha', 6: 'truecolour+alpha',
};

/**
 * Decodes a PNG into flat RGB bytes.
 *
 * @param {Buffer} buffer the file
 * @returns {{width: number, height: number, pixels: Uint8Array, hadAlpha: boolean,
 *   colourType: number, bitDepth: number}} `pixels` is `width * height * 3` bytes, RGB.
 *
 * Alpha is composited onto white rather than dropped. Dropping it turns a transparent
 * background into whatever colour the encoder happened to leave underneath — often
 * black, sometimes garbage — and the caller is told `hadAlpha` so it can say what was
 * assumed instead of quietly assuming it.
 */
export function decodePng(buffer) {
  if (buffer.length < 8 || !buffer.subarray(0, 8).equals(SIGNATURE)) {
    throw new Error('not a PNG: the file does not start with a PNG signature');
  }

  let header = null;
  let palette = null;
  let transparency = null;
  const idat = [];

  let offset = 8;
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const start = offset + 8;
    const end = start + length;
    if (end + 4 > buffer.length) {
      throw new Error(`truncated PNG: chunk ${type} claims ${length} bytes and the file ends first`);
    }
    const data = buffer.subarray(start, end);

    if (type === 'IHDR') header = readHeader(data);
    else if (type === 'PLTE') palette = data;
    else if (type === 'tRNS') transparency = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;

    // 4 more for the CRC, which is not checked: zlib will fail on corrupt image data,
    // and a CRC mismatch on an ancillary chunk this ignores is not worth refusing a file
    // over.
    offset = end + 4;
  }

  if (!header) throw new Error('invalid PNG: no IHDR chunk');
  if (idat.length === 0) throw new Error('invalid PNG: no image data');

  const { width, height, bitDepth, colourType, interlace } = header;

  if (interlace !== 0) {
    throw new Error(
      'this PNG is interlaced (Adam7), which `ash` does not decode. Re-save it without '
      + 'interlacing — most tools call this "progressive" — or pass --instances instead.',
    );
  }
  if (bitDepth !== 8 && bitDepth !== 16) {
    throw new Error(
      `this PNG is ${bitDepth}-bit, and \`ash\` decodes 8- and 16-bit images. Re-save it `
      + 'as 8-bit, or pass --instances instead.',
    );
  }
  if (!(colourType in CHANNELS)) {
    throw new Error(`invalid PNG: colour type ${colourType} is not one the format defines`);
  }
  if (colourType === 3 && !palette) {
    throw new Error('invalid PNG: an indexed image with no PLTE chunk');
  }

  const channels = CHANNELS[colourType];
  const bytesPerSample = bitDepth / 8;
  const bytesPerPixel = channels * bytesPerSample;
  const stride = width * bytesPerPixel;

  const raw = zlib.inflateSync(Buffer.concat(idat));
  if (raw.length < (stride + 1) * height) {
    throw new Error(
      `truncated PNG: ${raw.length} bytes of image data where ${(stride + 1) * height} were expected`,
    );
  }

  const scanlines = unfilter(raw, { height, stride, bytesPerPixel });
  const pixels = toRgb(scanlines, {
    width, height, stride, channels, bytesPerSample, colourType, palette, transparency,
  });

  return {
    width,
    height,
    pixels,
    hadAlpha: colourType === 4 || colourType === 6 || (colourType === 3 && transparency != null),
    colourType,
    bitDepth,
  };
}

function readHeader(data) {
  if (data.length < 13) throw new Error('invalid PNG: IHDR is too short');
  const width = data.readUInt32BE(0);
  const height = data.readUInt32BE(4);
  if (width === 0 || height === 0) throw new Error('invalid PNG: zero width or height');
  return {
    width,
    height,
    bitDepth: data[8],
    colourType: data[9],
    compression: data[10],
    filter: data[11],
    interlace: data[12],
  };
}

/**
 * Reverses the per-scanline filters, in place, into one contiguous buffer.
 *
 * Each scanline is prefixed with a filter byte and is defined in terms of the *already
 * reconstructed* bytes to its left and above, which is why this cannot be done lazily or
 * out of order. `a`, `b`, `c` below are the specification's names: left, above, and
 * above-left.
 */
function unfilter(raw, { height, stride, bytesPerPixel }) {
  const out = Buffer.allocUnsafe(stride * height);

  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const target = y * stride;
    const previous = target - stride;

    for (let x = 0; x < stride; x += 1) {
      const value = line[x];
      const a = x >= bytesPerPixel ? out[target + x - bytesPerPixel] : 0;
      const b = y > 0 ? out[previous + x] : 0;
      const c = y > 0 && x >= bytesPerPixel ? out[previous + x - bytesPerPixel] : 0;

      let reconstructed;
      switch (filter) {
        case 0: reconstructed = value; break;
        case 1: reconstructed = value + a; break;
        case 2: reconstructed = value + b; break;
        case 3: reconstructed = value + ((a + b) >> 1); break;
        case 4: reconstructed = value + paeth(a, b, c); break;
        default:
          throw new Error(`invalid PNG: unknown filter type ${filter} on scanline ${y}`);
      }
      out[target + x] = reconstructed & 0xff;
    }
  }
  return out;
}

/** The PNG specification's Paeth predictor: whichever of a, b, c is nearest a+b-c. */
function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/**
 * Expands whatever the file stored into straight RGB, compositing alpha onto white.
 *
 * 16-bit samples are taken from their high byte. That is a real loss of precision and it
 * is the right one here: the destination is an 8-bit-per-channel model input, so the low
 * byte would be discarded a step later anyway.
 */
function toRgb(scanlines, { width, height, stride, channels, bytesPerSample, colourType, palette, transparency }) {
  const rgb = new Uint8Array(width * height * 3);
  const sample = (row, index) => scanlines[row * stride + index * bytesPerSample];

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const base = x * channels;
      const out = (y * width + x) * 3;

      let r; let g; let b; let alpha = 255;

      if (colourType === 3) {
        const index = sample(y, base);
        if ((index + 1) * 3 > palette.length) {
          throw new Error(`invalid PNG: palette index ${index} is past the end of PLTE`);
        }
        r = palette[index * 3];
        g = palette[index * 3 + 1];
        b = palette[index * 3 + 2];
        if (transparency && index < transparency.length) alpha = transparency[index];
      } else if (colourType === 0 || colourType === 4) {
        r = sample(y, base);
        g = r;
        b = r;
        if (colourType === 4) alpha = sample(y, base + 1);
      } else {
        r = sample(y, base);
        g = sample(y, base + 1);
        b = sample(y, base + 2);
        if (colourType === 6) alpha = sample(y, base + 3);
      }

      if (alpha === 255) {
        rgb[out] = r;
        rgb[out + 1] = g;
        rgb[out + 2] = b;
      } else {
        // onto white
        const inverse = 255 - alpha;
        rgb[out] = Math.round((r * alpha + 255 * inverse) / 255);
        rgb[out + 1] = Math.round((g * alpha + 255 * inverse) / 255);
        rgb[out + 2] = Math.round((b * alpha + 255 * inverse) / 255);
      }
    }
  }
  return rgb;
}

/**
 * Takes the largest centred square, so resizing does not change the aspect ratio.
 *
 * A 1920x1080 photo squeezed into a square makes everything in it 1.8x too tall. The
 * model has never seen that and will say something confident about it anyway, which is
 * the failure mode this whole module is careful about: an answer that looks like a
 * prediction and is an artefact of the client.
 */
export function centreCrop({ width, height, pixels }) {
  const side = Math.min(width, height);
  if (side === width && side === height) return { width, height, pixels };

  const left = Math.floor((width - side) / 2);
  const top = Math.floor((height - side) / 2);
  const out = new Uint8Array(side * side * 3);

  for (let y = 0; y < side; y += 1) {
    const from = ((top + y) * width + left) * 3;
    out.set(pixels.subarray(from, from + side * 3), y * side * 3);
  }
  return { width: side, height: side, pixels: out };
}

/**
 * Resamples to `size`x`size` by averaging over the source area each output pixel covers.
 *
 * Not nearest-neighbour, which is the obvious way and is wrong for downscaling by the
 * factors involved here: sampling one pixel in every sixteen from a 512x512 photo throws
 * away 98% of the image and aliases whatever is left, so the 32x32 that reaches the model
 * is noise with the right dimensions. Averaging is what every image library's "area" or
 * "box" mode does, and it is a dozen lines.
 *
 * The weights are fractional coverage rather than whole pixels, which also makes this
 * correct when the source is smaller than the target and each output pixel is covered by
 * part of one input pixel.
 */
export function resizeTo({ width, height, pixels }, size = 32) {
  const out = new Uint8Array(size * size * 3);
  const scaleX = width / size;
  const scaleY = height / size;

  for (let ty = 0; ty < size; ty += 1) {
    const y0 = ty * scaleY;
    const y1 = (ty + 1) * scaleY;

    for (let tx = 0; tx < size; tx += 1) {
      const x0 = tx * scaleX;
      const x1 = (tx + 1) * scaleX;

      let r = 0; let g = 0; let b = 0; let total = 0;

      for (let sy = Math.floor(y0); sy < Math.min(height, Math.ceil(y1)); sy += 1) {
        const coverY = Math.min(y1, sy + 1) - Math.max(y0, sy);
        if (coverY <= 0) continue;

        for (let sx = Math.floor(x0); sx < Math.min(width, Math.ceil(x1)); sx += 1) {
          const coverX = Math.min(x1, sx + 1) - Math.max(x0, sx);
          if (coverX <= 0) continue;

          const weight = coverX * coverY;
          const at = (sy * width + sx) * 3;
          r += pixels[at] * weight;
          g += pixels[at + 1] * weight;
          b += pixels[at + 2] * weight;
          total += weight;
        }
      }

      const at = (ty * size + tx) * 3;
      out[at] = Math.round(r / total);
      out[at + 1] = Math.round(g / total);
      out[at + 2] = Math.round(b / total);
    }
  }

  return { width: size, height: size, pixels: out };
}

/** Flat RGB bytes as the nested `[height][width][3]` array the model server takes. */
export function toInstance({ width, height, pixels }) {
  const rows = [];
  for (let y = 0; y < height; y += 1) {
    const row = [];
    for (let x = 0; x < width; x += 1) {
      const at = (y * width + x) * 3;
      row.push([pixels[at], pixels[at + 1], pixels[at + 2]]);
    }
    rows.push(row);
  }
  return rows;
}

/**
 * The whole path from a file to one instance, and a description of what it did to get
 * there.
 *
 * The description is not decoration. A prediction about a 1920x1080 photograph reduced to
 * 32x32 is a prediction about something the user cannot see, and printing "cropped to
 * 1080x1080, resized to 32x32" is what keeps a bad answer attributable to the image
 * rather than to the model.
 */
export function imageToInstance(buffer, { size = 32 } = {}) {
  const decoded = decodePng(buffer);
  const cropped = centreCrop(decoded);
  const resized = resizeTo(cropped, size);

  const steps = [`${decoded.width}x${decoded.height} ${COLOUR_NAMES[decoded.colourType] ?? 'PNG'}`];
  if (cropped.width !== decoded.width || cropped.height !== decoded.height) {
    steps.push(`centre-cropped to ${cropped.width}x${cropped.height}`);
  }
  if (cropped.width !== size || cropped.height !== size) {
    steps.push(`resized to ${size}x${size} (area average)`);
  }
  if (decoded.hadAlpha) steps.push('transparency composited onto white');

  return { instance: toInstance(resized), describe: steps.join(', ') };
}
