"""Alibaba Cloud OSS connectivity / credential test (V1 signature, stdlib only)."""
import base64
import hashlib
import hmac
import os
import sys
import urllib.request
import urllib.error
from email.utils import formatdate

AK = os.environ["OSS_AK"]
SK = os.environ["OSS_SK"]
BUCKET = os.environ.get("OSS_BUCKET", "self-hub")
HOST = f"{BUCKET}.oss-cn-beijing.aliyuncs.com"


def sign(verb, resource, content_type="", content_md5="", date=None, oss_headers=None):
    date = date or formatdate(usegmt=True)
    oss_headers = oss_headers or {}
    canon_oss = "".join(
        f"{k.lower()}:{v}\n" for k, v in sorted(oss_headers.items())
    )
    string_to_sign = f"{verb}\n{content_md5}\n{content_type}\n{date}\n{canon_oss}{resource}"
    sig = base64.b64encode(
        hmac.new(SK.encode(), string_to_sign.encode(), hashlib.sha1).digest()
    ).decode()
    return f"OSS {AK}:{sig}", date


# OSS V1: only these sub-resources enter CanonicalizedResource.
SUBRESOURCES = {
    "acl", "uploads", "location", "cors", "logging", "website", "referer",
    "lifecycle", "delete", "append", "tagging", "objectMeta", "uploadId",
    "partNumber", "security-token", "position", "response-content-type",
    "response-content-language", "response-expires", "response-cache-control",
    "response-content-disposition", "response-content-encoding", "udf",
    "udfName", "udfImage", "udfId", "udfImageDesc", "udfApplication",
    "udfApplicationLog", "restore", "callback", "callback-var", "qos",
    "qosInfo", "policy", "policyStatus", "encryption", "versioning",
    "versionId", "requestPayment", "versions", "objectInfo", "bucketInfo",
    "stat", "comp", "live", "status", "vod", "startTime", "endTime",
    "symlink", "x-oss-process", "img", "style", "styleName", "replication",
    "replicationProgress", "replicationLocation", "cname",
}


def canonical_query(query):
    if not query.startswith("?"):
        return ""
    parts = []
    for item in query[1:].split("&"):
        k = item.split("=", 1)[0]
        if k in SUBRESOURCES:
            parts.append(item)
    return "?" + "&".join(sorted(parts)) if parts else ""


def request(verb, path="/", query="", body=b"", content_type="", extra=None):
    resource = f"/{BUCKET}{path}" if path else f"/{BUCKET}/"
    headers = dict(extra or {})
    auth, date = sign(verb, resource + canonical_query(query),
                      content_type=content_type)
    req = urllib.request.Request(
        f"https://{HOST}{path}{query}", data=body if body else None, method=verb
    )
    req.add_header("Date", date)
    req.add_header("Authorization", auth)
    if content_type:
        req.add_header("Content-Type", content_type)
    for k, v in headers.items():
        req.add_header(k, v)
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return r.status, dict(r.headers), r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.status, dict(e.headers), e.read().decode("utf-8", "replace")
    except Exception as e:  # noqa: BLE001
        return -1, {}, f"{type(e).__name__}: {e}"


def show(label, status, body, limit=900):
    ok = "OK " if 200 <= status < 300 else "FAIL"
    snippet = body.replace("\n", " ")[:limit]
    print(f"[{ok}] {label} -> HTTP {status}\n      {snippet}\n")


def main():
    print(f"Endpoint : https://{HOST}\nBucket   : {BUCKET}\n")

    # 1. Service-level: list all buckets owned by this AK
    st, _, body = request("GET", "/", "")
    show("ListBuckets (GET /)", st, body, 400)

    # 2. Bucket info -> proves the AK has access to this bucket
    st, _, body = request("GET", "/", "?bucketInfo")
    show("GetBucketInfo", st, body, 500)

    # 3. ACL / region / storage class
    for q, label in (("?acl", "GetBucketAcl"), ("?location", "GetBucketLocation"),
                     ("?stat", "GetBucketStat")):
        st, _, body = request("GET", "/", q)
        show(label, st, body, 400)

    # 4. List objects (v2)
    st, _, body = request("GET", "/", "?list-type=2&max-keys=10")
    show("ListObjectsV2 (max-keys=10)", st, body, 1200)

    # 5. Write / read / delete round-trip on a throwaway key
    key = "_dsh_conn_test/hello.txt"
    payload = b"dsh oss connectivity test"
    st, _, body = request("PUT", f"/{key}", "", payload, "text/plain")
    show(f"PUT /{key}", st, body, 300)

    st, _, body = request("GET", f"/{key}")
    show(f"GET /{key}", st, body, 300)

    # 6. List with prefix + delimiter to prove listing reflects real objects
    st, _, body = request(
        "GET", "/", "?list-type=2&prefix=_dsh_conn_test/&delimiter=/&max-keys=10"
    )
    show("ListObjectsV2 (prefix=_dsh_conn_test/)", st, body, 800)

    st, _, body = request("DELETE", f"/{key}")
    show(f"DELETE /{key} (cleanup)", st, body, 300)

    # 7. Confirm the probe object is really gone
    st, _, body = request("GET", "/", "?list-type=2&prefix=_dsh_conn_test/")
    show("ListObjectsV2 (verify cleanup)", st, body, 500)


if __name__ == "__main__":
    sys.exit(main())
