/**
 * Tests for the PNG decoder.
 *
 * Every fixture below was produced by an *independent* encoder — Python's zlib and
 * struct, in `scripts/cifar-png.py`'s idiom — rather than by anything in this repository.
 * A decoder tested against its own encoder proves the two agree, which is not the claim
 * that matters: the claim is that a file written by something else decodes to the pixels
 * that something else put in it.
 *
 * The expected pixel values are likewise the encoder's inputs, not this decoder's output
 * recorded after the fact.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { decodePng, centreCrop, resizeTo, toInstance, imageToInstance } from './png.js';

const from64 = (text) => Buffer.from(text, 'base64');

/** 4x4 truecolour. Its four scanlines use filters Sub, Up, Average and Paeth — one of
 *  each of the interesting ones, because the filter is per scanline and a decoder can
 *  easily get three of them right. */
const TRUECOLOUR_4x4 = from64(
  'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAKklEQVR42mNkYGDQYOfWYFfUYDdnYr'
  + 'ZhRSDWKA4xJSASFlOSYwEJsEMRAGmMA8Swc4flAAAAAElFTkSuQmCC',
);
const TRUECOLOUR_4x4_PIXELS = [
  [[0, 0, 0], [40, 7, 11], [80, 14, 44], [120, 21, 99]],
  [[3, 60, 5], [43, 67, 16], [83, 74, 49], [123, 81, 104]],
  [[6, 120, 10], [46, 127, 21], [86, 134, 54], [126, 141, 109]],
  [[9, 180, 15], [49, 187, 26], [89, 194, 59], [129, 201, 114]],
];

/** 3x2 indexed, with a tRNS chunk making the middle colour half transparent. */
const INDEXED_TRNS_3x2 = from64(
  'iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAMAAACqqpYoAAAACVBMVEX/AAAA/wAAAP8tSs2KAAAAA3'
  + 'RSTlP/gP9Sb4f1AAAAEElEQVR42mNgYGRiYfr/DwADKgIHL7m8gQAAAABJRU5ErkJggg==',
);
const INDEXED_TRNS_3x2_PIXELS = [
  [[255, 0, 0], [127, 255, 127], [0, 0, 255]],
  [[0, 0, 255], [127, 255, 127], [255, 0, 0]],
];

/** 2x2 greyscale with an alpha channel, including one fully transparent pixel. */
const GREY_ALPHA_2x2 = from64(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAQAAADYv8WvAAAAEklEQVR42mPg+n+CgTHKYel+ABIKA9'
  + 'Ht3FYCAAAAAElFTkSuQmCC',
);
const GREY_ALPHA_2x2_PIXELS = [
  [[10, 10, 10], [255, 255, 255]],
  [[214, 214, 214], [255, 255, 255]],
];

/** 2x1 truecolour at 16 bits per sample. */
const SIXTEEN_BIT_2x1 = from64(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAABEAIAAAAr0DSeAAAAFUlEQVR42mMQMgmrmLXn3gdGpn//AC'
  + 'GRBjhVk2AhAAAAAElFTkSuQmCC',
);
const SIXTEEN_BIT_2x1_PIXELS = [[[18, 86, 154], [222, 1, 254]]];

describe('decoding PNG', () => {
  test('truecolour, with a different scanline filter on every row', () => {
    const image = decodePng(TRUECOLOUR_4x4);
    assert.equal(image.width, 4);
    assert.equal(image.height, 4);
    assert.equal(image.hadAlpha, false);
    assert.deepEqual(toInstance(image), TRUECOLOUR_4x4_PIXELS);
  });

  test('an indexed image resolves its palette', () => {
    const image = decodePng(INDEXED_TRNS_3x2);
    assert.deepEqual(toInstance(image), INDEXED_TRNS_3x2_PIXELS);
  });

  test('transparency is composited onto white rather than dropped', () => {
    // Dropping alpha leaves whatever the encoder stored underneath — often black — and
    // a black rectangle where the user saw nothing is a prediction about the wrong
    // image. The fully transparent pixel here must come out white, not [200,200,200].
    const image = decodePng(GREY_ALPHA_2x2);
    assert.equal(image.hadAlpha, true);
    assert.deepEqual(toInstance(image), GREY_ALPHA_2x2_PIXELS);
  });

  test('an indexed image with tRNS reports that it had alpha', () => {
    assert.equal(decodePng(INDEXED_TRNS_3x2).hadAlpha, true);
  });

  test('16-bit samples are taken from their high byte', () => {
    assert.deepEqual(toInstance(decodePng(SIXTEEN_BIT_2x1)), SIXTEEN_BIT_2x1_PIXELS);
  });

  test('a file that is not a PNG is refused by name', () => {
    assert.throws(() => decodePng(Buffer.from('GIF89a and then some')), /not a PNG/);
  });

  test('a truncated file is refused rather than decoded to garbage', () => {
    // Cut inside IDAT, which is the case worth catching: the chunk header still says how
    // many bytes should follow, and inflating whatever did arrive would produce a
    // partial image rather than an error.
    assert.throws(() => decodePng(TRUECOLOUR_4x4.subarray(0, 50)), /truncated PNG/);
  });

  test('a file that stops before any image data says that, not something vaguer', () => {
    assert.throws(() => decodePng(TRUECOLOUR_4x4.subarray(0, 33)), /no image data/);
  });

  test('an interlaced PNG says so, and says what to do about it', () => {
    // Half-decoding Adam7 as if it were sequential produces a plausible-looking image
    // that is not the image. Refusing is the only honest option, and the message has to
    // name the fix — the user did not choose "Adam7", they ticked "progressive".
    const interlaced = Buffer.from(TRUECOLOUR_4x4);
    interlaced[8 + 8 + 12] = 1; // IHDR's interlace byte
    assert.throws(() => decodePng(interlaced), /interlaced \(Adam7\)/);
  });

  test('a bit depth this decoder does not handle is refused, not approximated', () => {
    const fourBit = Buffer.from(TRUECOLOUR_4x4);
    fourBit[8 + 8 + 8] = 4; // IHDR's bit-depth byte
    assert.throws(() => decodePng(fourBit), /4-bit/);
  });
});

describe('preparing an image for a model', () => {
  const solid = (width, height, colour) => ({
    width,
    height,
    pixels: Uint8Array.from({ length: width * height * 3 }, (_, i) => colour[i % 3]),
  });

  test('a non-square image is cropped from the centre, not squashed', () => {
    // 1.8:1 squashed into a square makes everything in it 1.8x too tall — a distortion
    // the model has never seen and will still answer confidently about.
    const cropped = centreCrop(solid(90, 50, [1, 2, 3]));
    assert.equal(cropped.width, 50);
    assert.equal(cropped.height, 50);
  });

  test('the crop takes the middle, not the corner', () => {
    // A 3x1 strip of red, green, blue: the centred 1x1 crop is the green one. A decoder
    // that crops from the origin returns red and nothing ever says it did.
    const strip = {
      width: 3,
      height: 1,
      pixels: Uint8Array.from([255, 0, 0, 0, 255, 0, 0, 0, 255]),
    };
    assert.deepEqual(toInstance(centreCrop(strip)), [[[0, 255, 0]]]);
  });

  test('an already-square image is left alone', () => {
    const square = solid(32, 32, [7, 8, 9]);
    assert.equal(centreCrop(square).pixels, square.pixels);
  });

  test('resizing averages the area, so downscaling keeps the picture', () => {
    // Nearest-neighbour on this input returns one of the four corners and calls it the
    // image. Averaging returns the mean, which is what "the image at 1x1" means.
    const quad = {
      width: 2,
      height: 2,
      pixels: Uint8Array.from([0, 0, 0, 100, 100, 100, 200, 200, 200, 255, 255, 255]),
    };
    assert.deepEqual(toInstance(resizeTo(quad, 1)), [[[139, 139, 139]]]);
  });

  test('a 4x4 gradient survives being halved', () => {
    const image = decodePng(TRUECOLOUR_4x4);
    const half = resizeTo(image, 2);
    // Top-left output pixel is the mean of the four top-left input pixels.
    const mean = (channel) => Math.round(
      (TRUECOLOUR_4x4_PIXELS[0][0][channel] + TRUECOLOUR_4x4_PIXELS[0][1][channel]
        + TRUECOLOUR_4x4_PIXELS[1][0][channel] + TRUECOLOUR_4x4_PIXELS[1][1][channel]) / 4,
    );
    assert.deepEqual(toInstance(half)[0][0], [mean(0), mean(1), mean(2)]);
  });

  test('upscaling covers every output pixel rather than dividing by zero', () => {
    // Each output pixel is covered by a fraction of one input pixel here, which is the
    // branch where a coverage-weighted resampler most easily accumulates no weight.
    const grown = resizeTo(decodePng(SIXTEEN_BIT_2x1), 4);
    assert.equal(grown.pixels.length, 4 * 4 * 3);
    assert.ok(grown.pixels.every(Number.isFinite));
  });

  test('the instance is [row][column][rgb], which is what the server expects', () => {
    const { instance } = imageToInstance(TRUECOLOUR_4x4, { size: 4 });
    assert.equal(instance.length, 4);
    assert.equal(instance[0].length, 4);
    assert.deepEqual(instance[0][1], TRUECOLOUR_4x4_PIXELS[0][1]);
  });

  test('what was done to the image is reported, not silently applied', () => {
    // The description is what keeps a bad prediction attributable to a 32x32 crop of a
    // photograph rather than to the model.
    const { describe: how } = imageToInstance(GREY_ALPHA_2x2, { size: 32 });
    assert.match(how, /2x2 greyscale\+alpha/);
    assert.match(how, /resized to 32x32/);
    assert.match(how, /composited onto white/);
  });
});
