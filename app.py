#!/usr/bin/env python3
"""
mysharedbucket — a tiny dropbox-like file server for a trusted local network.

Zero third-party dependencies: standard library only. Streams uploads straight
to disk so multi-GB files don't blow up memory.

Config via environment variables:
    SHARE_DIR   storage root              (default: ./storage)
    HOST        bind address              (default: 0.0.0.0 — all interfaces)
    PORT        bind port                 (default: 8000)
    MAX_UPLOAD  reject bodies larger than this many bytes (default: 0 = no limit)

No authentication by design — intended for a LAN you trust.
"""

import json
import os
import shutil
import socket
import sys
import urllib.parse
import zipfile
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
SHARE_DIR = os.path.abspath(os.environ.get("SHARE_DIR", os.path.join(HERE, "storage")))
STATIC_DIR = os.path.join(HERE, "static")
HOST = os.environ.get("HOST", "0.0.0.0")
PORT = int(os.environ.get("PORT", "8000"))
MAX_UPLOAD = int(os.environ.get("MAX_UPLOAD", "0"))
CHUNK = 1024 * 1024  # 1 MiB streaming chunk

os.makedirs(SHARE_DIR, exist_ok=True)
SHARE_REAL = os.path.realpath(SHARE_DIR)
MAX_JSON = 1024 * 1024  # cap control-request bodies (mkdir/delete/rename/move/zip)


# --------------------------------------------------------------------------- #
# Path safety
# --------------------------------------------------------------------------- #
def safe_join(rel):
    """Resolve a client-supplied relative path inside SHARE_DIR or raise."""
    rel = (rel or "").strip().lstrip("/")
    # Normalise and forbid anything that climbs out of the share root.
    full = os.path.abspath(os.path.join(SHARE_DIR, rel))
    if full != SHARE_DIR and not full.startswith(SHARE_DIR + os.sep):
        raise ValueError("path escapes storage root")
    # Defence in depth: also resolve symlinks so a link inside the share can't
    # point the real target outside it (the lexical check above is link-blind).
    real = os.path.realpath(full)
    if real != SHARE_REAL and not real.startswith(SHARE_REAL + os.sep):
        raise ValueError("path escapes storage root")
    return full


def rel_of(full):
    rel = os.path.relpath(full, SHARE_DIR)
    return "" if rel == "." else rel.replace(os.sep, "/")


class _ChunkedWriter:
    """Wraps the response stream so a ZipFile can be streamed with HTTP
    chunked transfer encoding (no temp file, no in-memory buffering, no need
    to know the final size up front). Deliberately exposes no tell()/seek(),
    which makes zipfile fall back to its non-seekable streaming mode."""

    def __init__(self, wfile):
        self.wfile = wfile

    def write(self, data):
        n = len(data)
        if n:
            self.wfile.write(b"%X\r\n" % n)
            self.wfile.write(data)
            self.wfile.write(b"\r\n")
        return n

    def flush(self):
        self.wfile.flush()

    def close(self):
        self.wfile.write(b"0\r\n\r\n")


# --------------------------------------------------------------------------- #
# Request handler
# --------------------------------------------------------------------------- #
class Handler(BaseHTTPRequestHandler):
    server_version = "mysharedbucket/1.0"
    protocol_version = "HTTP/1.1"

    # ----- small helpers ------------------------------------------------- #
    def _send_json(self, obj, status=HTTPStatus.OK):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _error(self, status, message):
        self._send_json({"error": message}, status=status)

    def _query(self):
        parts = urllib.parse.urlsplit(self.path)
        return parts.path, urllib.parse.parse_qs(parts.query)

    def _read_json_body(self):
        length = int(self.headers.get("Content-Length", "0"))
        if length > MAX_JSON:
            raise ValueError("request too large")
        raw = self.rfile.read(length) if length else b""
        return json.loads(raw or b"{}")

    # ----- routing ------------------------------------------------------- #
    def do_GET(self):
        path, q = self._query()
        try:
            if path == "/" or path == "/index.html":
                return self._serve_static("index.html")
            if path.startswith("/static/"):
                return self._serve_static(path[len("/static/"):])
            if path == "/api/list":
                return self._api_list(q.get("path", [""])[0])
            if path == "/api/download":
                return self._api_download(q.get("path", [""])[0])
            return self._error(HTTPStatus.NOT_FOUND, "not found")
        except ValueError as e:
            return self._error(HTTPStatus.BAD_REQUEST, str(e))
        except BrokenPipeError:
            pass
        except Exception as e:  # noqa: BLE001
            # Log the detail server-side; don't leak paths/errno to the client.
            sys.stderr.write(f"error handling {self.command} {self.path}: {e!r}\n")
            return self._error(HTTPStatus.INTERNAL_SERVER_ERROR, "internal server error")

    def do_PUT(self):
        path, q = self._query()
        try:
            if path == "/api/upload":
                return self._api_upload(q.get("path", [""])[0])
            return self._error(HTTPStatus.NOT_FOUND, "not found")
        except ValueError as e:
            return self._error(HTTPStatus.BAD_REQUEST, str(e))
        except Exception as e:  # noqa: BLE001
            # Log the detail server-side; don't leak paths/errno to the client.
            sys.stderr.write(f"error handling {self.command} {self.path}: {e!r}\n")
            return self._error(HTTPStatus.INTERNAL_SERVER_ERROR, "internal server error")

    def do_POST(self):
        path, _ = self._query()
        try:
            if path == "/api/mkdir":
                return self._api_mkdir()
            if path == "/api/delete":
                return self._api_delete()
            if path == "/api/rename":
                return self._api_rename()
            if path == "/api/move":
                return self._api_move()
            if path == "/api/zip":
                return self._api_zip()
            return self._error(HTTPStatus.NOT_FOUND, "not found")
        except ValueError as e:
            return self._error(HTTPStatus.BAD_REQUEST, str(e))
        except Exception as e:  # noqa: BLE001
            # Log the detail server-side; don't leak paths/errno to the client.
            sys.stderr.write(f"error handling {self.command} {self.path}: {e!r}\n")
            return self._error(HTTPStatus.INTERNAL_SERVER_ERROR, "internal server error")

    # ----- static files -------------------------------------------------- #
    def _serve_static(self, rel):
        rel = rel.lstrip("/")
        full = os.path.abspath(os.path.join(STATIC_DIR, rel))
        # Require the separator so a sibling like ".../static_secret" can't
        # satisfy a bare startswith(".../static") prefix check.
        if not full.startswith(STATIC_DIR + os.sep) or not os.path.isfile(full):
            return self._error(HTTPStatus.NOT_FOUND, "not found")
        ctype = {
            ".html": "text/html; charset=utf-8",
            ".js": "application/javascript; charset=utf-8",
            ".css": "text/css; charset=utf-8",
            ".svg": "image/svg+xml",
            ".ico": "image/x-icon",
        }.get(os.path.splitext(full)[1], "application/octet-stream")
        size = os.path.getsize(full)
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(size))
        self.end_headers()
        with open(full, "rb") as f:
            shutil.copyfileobj(f, self.wfile, CHUNK)

    # ----- API: list ----------------------------------------------------- #
    def _api_list(self, rel):
        full = safe_join(rel)
        if not os.path.isdir(full):
            return self._error(HTTPStatus.NOT_FOUND, "folder not found")
        dirs, files = [], []
        with os.scandir(full) as it:
            for entry in it:
                try:
                    st = entry.stat()
                except OSError:
                    continue
                item = {
                    "name": entry.name,
                    "path": rel_of(entry.path),
                    "size": st.st_size,
                    "modified": int(st.st_mtime),
                    "is_dir": entry.is_dir(),
                }
                (dirs if entry.is_dir() else files).append(item)
        dirs.sort(key=lambda x: x["name"].lower())
        files.sort(key=lambda x: x["name"].lower())
        usage = shutil.disk_usage(SHARE_DIR)
        return self._send_json({
            "path": rel_of(full),
            "items": dirs + files,
            "disk": {"total": usage.total, "free": usage.free, "used": usage.used},
        })

    # ----- API: download ------------------------------------------------- #
    def _api_download(self, rel):
        full = safe_join(rel)
        if not os.path.isfile(full):
            return self._error(HTTPStatus.NOT_FOUND, "file not found")
        size = os.path.getsize(full)
        name = os.path.basename(full)
        disp = "attachment; filename*=UTF-8''" + urllib.parse.quote(name)
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "application/octet-stream")
        self.send_header("Content-Length", str(size))
        self.send_header("Content-Disposition", disp)
        self.end_headers()
        try:
            with open(full, "rb") as f:
                shutil.copyfileobj(f, self.wfile, CHUNK)
        except BrokenPipeError:
            pass

    # ----- API: upload (raw streamed body) ------------------------------- #
    def _api_upload(self, rel):
        full = safe_join(rel)
        if os.path.isdir(full):
            raise ValueError("target is a directory")
        os.makedirs(os.path.dirname(full), exist_ok=True)
        length = int(self.headers.get("Content-Length", "0"))
        if MAX_UPLOAD and length > MAX_UPLOAD:
            return self._error(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "file too large")
        tmp = full + ".part"
        remaining = length
        try:
            with open(tmp, "wb") as f:
                while remaining > 0:
                    chunk = self.rfile.read(min(CHUNK, remaining))
                    if not chunk:
                        break
                    f.write(chunk)
                    remaining -= len(chunk)
            if remaining > 0:
                raise IOError("connection closed before upload finished")
            os.replace(tmp, full)
        except Exception:
            if os.path.exists(tmp):
                os.remove(tmp)
            raise
        return self._send_json({"ok": True, "path": rel_of(full)})

    # ----- API: mkdir / delete / rename ---------------------------------- #
    def _api_mkdir(self):
        data = self._read_json_body()
        full = safe_join(data.get("path", ""))
        if full == SHARE_DIR:
            raise ValueError("invalid name")
        os.makedirs(full, exist_ok=True)
        return self._send_json({"ok": True, "path": rel_of(full)})

    def _api_delete(self):
        data = self._read_json_body()
        full = safe_join(data.get("path", ""))
        if full == SHARE_DIR:
            raise ValueError("cannot delete root")
        if os.path.isdir(full):
            shutil.rmtree(full)
        elif os.path.exists(full):
            os.remove(full)
        else:
            return self._error(HTTPStatus.NOT_FOUND, "not found")
        return self._send_json({"ok": True})

    def _api_rename(self):
        data = self._read_json_body()
        src = safe_join(data.get("path", ""))
        new_name = (data.get("name") or "").strip()
        if not new_name or "/" in new_name or new_name in (".", ".."):
            raise ValueError("invalid name")
        if src == SHARE_DIR or not os.path.exists(src):
            raise ValueError("source not found")
        dst = os.path.join(os.path.dirname(src), new_name)
        if os.path.exists(dst):
            raise ValueError("a file with that name already exists")
        os.rename(src, dst)
        return self._send_json({"ok": True, "path": rel_of(dst)})

    def _api_move(self):
        data = self._read_json_body()
        src = safe_join(data.get("path", ""))
        dest_dir = safe_join(data.get("dest", ""))
        if src == SHARE_DIR:
            raise ValueError("cannot move root")
        if not os.path.exists(src):
            raise ValueError("source not found")
        if not os.path.isdir(dest_dir):
            raise ValueError("destination is not a folder")
        # Already in the destination → nothing to do.
        if os.path.dirname(src) == dest_dir:
            return self._send_json({"ok": True, "path": rel_of(src)})
        # Forbid moving a folder into itself or one of its descendants.
        if os.path.isdir(src) and (
            dest_dir == src or dest_dir.startswith(src + os.sep)
        ):
            raise ValueError("cannot move a folder into itself")
        target = os.path.join(dest_dir, os.path.basename(src))
        if os.path.exists(target):
            raise ValueError("an item with that name already exists there")
        os.rename(src, target)
        return self._send_json({"ok": True, "path": rel_of(target)})

    # ----- API: zip (stream a bundle of files/folders) ------------------- #
    def _api_zip(self):
        # Accepts JSON {"paths": [...]} or a form POST with repeated `path=`
        # fields (the latter lets the browser trigger a native download).
        length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(length) if length else b""
        ctype = self.headers.get("Content-Type", "")
        if "application/json" in ctype:
            paths = (json.loads(raw or b"{}")).get("paths", [])
        else:
            paths = urllib.parse.parse_qs(raw.decode("utf-8")).get("path", [])

        # Resolve the selection into a flat list of (file_on_disk, name_in_zip).
        entries = []
        for rel in paths:
            try:
                full = safe_join(rel)
            except ValueError:
                continue
            if os.path.isdir(full):
                base = os.path.basename(full.rstrip("/")) or "folder"
                for root, _dirs, files in os.walk(full):
                    for fn in files:
                        fp = os.path.join(root, fn)
                        arc = os.path.join(base, os.path.relpath(fp, full))
                        entries.append((fp, arc))
            elif os.path.isfile(full):
                entries.append((full, os.path.basename(full)))

        if not entries:
            return self._error(HTTPStatus.BAD_REQUEST, "nothing to download")

        # Name the archive after a single selected folder, else generically.
        if len(paths) == 1:
            zip_name = (os.path.basename(paths[0].rstrip("/")) or "bucket") + ".zip"
        else:
            zip_name = "mysharedbucket.zip"
        disp = "attachment; filename*=UTF-8''" + urllib.parse.quote(zip_name)

        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "application/zip")
        self.send_header("Content-Disposition", disp)
        self.send_header("Transfer-Encoding", "chunked")
        self.end_headers()

        writer = _ChunkedWriter(self.wfile)
        try:
            # compresslevel=1 keeps large/already-compressed media fast.
            with zipfile.ZipFile(writer, "w", zipfile.ZIP_DEFLATED,
                                 allowZip64=True, compresslevel=1) as zf:
                for fp, arc in entries:
                    try:
                        zf.write(fp, arc)
                    except OSError:
                        continue  # file vanished/locked mid-zip — skip it
            writer.close()
        except (BrokenPipeError, ConnectionResetError):
            pass  # client cancelled the download

    # ----- quieter logging ----------------------------------------------- #
    def log_message(self, fmt, *args):
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))


def _lan_ip():
    """Best-effort primary LAN IP for the startup banner."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()


def main():
    httpd = ThreadingHTTPServer((HOST, PORT), Handler)
    httpd.daemon_threads = True
    ip = _lan_ip()
    print(f"mysharedbucket serving {SHARE_DIR}")
    print(f"  local:   http://127.0.0.1:{PORT}")
    print(f"  network: http://{ip}:{PORT}")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nshutting down")
        httpd.shutdown()


if __name__ == "__main__":
    main()
