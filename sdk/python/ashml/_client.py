"""HTTP against the AshML control plane, using nothing but the standard library.

A training image already carries PyTorch, CUDA and half of scipy. Adding ``requests``
to it is another pin to maintain, another wheel to resolve, and another thing that can
conflict with whatever the user's base image already has. ``urllib`` is not as pleasant
to write against, but it is always there.

Everything here is deliberately small: one request function, one retry policy, one error
type. The SDK's job is to report, not to be a framework.
"""

from __future__ import annotations

import json
import random
import time
import urllib.error
import urllib.request

__all__ = ["ApiError", "Client"]


class ApiError(RuntimeError):
    """A request the control plane refused, or one that never got through.

    ``code`` is AshML's stable error code where the server sent one (spec §45), so a
    caller can branch on ``JOB_NOT_STARTED`` without matching on prose. It is ``None``
    for transport failures, which have no server-side code by definition.
    """

    def __init__(self, message: str, *, status: int | None = None, code: str | None = None):
        super().__init__(message)
        self.status = status
        self.code = code

    @property
    def retryable(self) -> bool:
        """Whether trying the identical request again could plausibly succeed.

        A 4xx is the server saying the request is wrong; repeating it wastes time and
        hides the problem. A 5xx or a transport failure may be a restart or a blip.
        """
        if self.status is None:
            return True
        return self.status >= 500 or self.status == 429


class Client:
    """A thin HTTP client for one AshML endpoint.

    Retries are bounded and jittered. The training process is the caller, so time spent
    here is time a GPU spends idle: the defaults are tuned to survive a control-plane
    restart, not to wait out an outage.
    """

    def __init__(
        self,
        endpoint: str,
        *,
        timeout: float = 10.0,
        retries: int = 3,
        token: str | None = None,
    ):
        self.endpoint = endpoint.rstrip("/")
        self.timeout = timeout
        self.retries = retries
        # The run token the control plane injected into this pod (Phase 10). Read from
        # the environment by ``ashml.init`` rather than here, so that this class stays a
        # plain HTTP client with no opinion about where it is running.
        self.token = token

    def request(self, method: str, path: str, body: dict | None = None) -> dict:
        url = f"{self.endpoint}{path}"
        data = json.dumps(body).encode() if body is not None else None
        headers = {"content-type": "application/json"} if data else {}
        if self.token:
            headers["authorization"] = f"Bearer {self.token}"

        last: ApiError | None = None
        for attempt in range(self.retries + 1):
            try:
                return self._once(method, url, data, headers)
            except ApiError as err:
                last = err
                if not err.retryable or attempt == self.retries:
                    raise
                # Full jitter: a hundred pods whose control plane just restarted must
                # not all come back at the same instant and knock it over again.
                time.sleep(random.uniform(0, min(2**attempt * 0.5, 8.0)))

        raise last  # unreachable; kept so the type is obvious

    def _once(self, method: str, url: str, data: bytes | None, headers: dict) -> dict:
        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as res:
                raw = res.read()
                return json.loads(raw) if raw else {}
        except urllib.error.HTTPError as err:
            raise _from_http_error(err) from err
        except (urllib.error.URLError, TimeoutError, OSError) as err:
            raise ApiError(f"{method} {url} failed: {err}") from err


def _from_http_error(err: urllib.error.HTTPError) -> ApiError:
    """Unwraps AshML's error envelope, falling back to the raw body."""
    try:
        payload = json.loads(err.read())
        envelope = payload["error"]
        return ApiError(envelope["message"], status=err.code, code=envelope["code"])
    except Exception:
        # A proxy, a gateway, or an error page. The status is still the useful part.
        return ApiError(f"HTTP {err.code} from {err.url}", status=err.code)
