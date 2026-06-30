# mysharedbucket HTTP API

A tiny, **unauthenticated** file-drop service for a trusted LAN. Everything is
plain HTTP against a single server (`app.py`). There are no tokens, cookies, or
sessions — anyone who can reach the host can use every endpoint.

- **Base URL:** `http://HOST:PORT` (default port `8000`)
- **Paths** in requests are always **relative to the share root** (`SHARE_DIR`),
  use `/` separators, and never start with `/`. `..` and absolute paths are
  rejected (`safe_join`). The root itself is the empty string `""`.
- **JSON in, JSON out** for mutating calls; raw bytes for upload/download/zip.
- **Errors** return a non-2xx status with body `{"error": "<message>"}`.

## Endpoints

| Method | Path            | Purpose                          | Body |
|--------|-----------------|----------------------------------|------|
| GET    | `/api/list`     | list a folder                    | —    |
| GET    | `/api/download` | download one file                | —    |
| PUT    | `/api/upload`   | upload one file (raw stream)     | raw file bytes |
| POST   | `/api/mkdir`    | create a folder (incl. parents)  | JSON |
| POST   | `/api/delete`   | delete a file or folder (recursive) | JSON |
| POST   | `/api/rename`   | rename in place                  | JSON |
| POST   | `/api/move`     | move into another folder         | JSON |
| POST   | `/api/zip`      | stream a ZIP of files/folders    | JSON or form |

---

### GET `/api/list?path=<rel>`

List the contents of a folder. `path=` (empty) lists the root.

```bash
curl -fsS "http://HOST:8000/api/list?path=docs"
```

Response:

```json
{
  "path": "docs",
  "items": [
    {"name": "2026", "path": "docs/2026", "size": 60,
     "modified": 1782782062, "is_dir": true},
    {"name": "report.pdf", "path": "docs/report.pdf", "size": 20480,
     "modified": 1782782062, "is_dir": false}
  ],
  "disk": {"total": 8020152320, "free": 7158226944, "used": 861925376}
}
```

Folders sort first, then files; both alphabetical (case-insensitive).
`modified` is a Unix timestamp (seconds). 404 if the folder doesn't exist.

### GET `/api/download?path=<rel>`

Download a single file. Streams raw bytes with a `Content-Disposition`
attachment header. 404 if the path is not a file.

```bash
curl -fSL -o report.pdf "http://HOST:8000/api/download?path=docs/report.pdf"
```

### PUT `/api/upload?path=<rel>`

Upload one file. The **request body is the raw file content** (not multipart).
`path=` is the **full destination including the filename**. Missing parent
folders are created automatically. An existing file at that path is overwritten.

```bash
curl -fSL -T report.pdf "http://HOST:8000/api/upload?path=docs/2026/report.pdf"
```

- URL-encode `path` if it contains spaces/special characters (`%20`, etc.).
- The upload streams to a `<name>.part` temp file, then atomically renames on
  completion; a dropped connection leaves no partial file.
- Honors `MAX_UPLOAD` (bytes) if the server set it → `413` when exceeded.
- Response: `{"ok": true, "path": "docs/2026/report.pdf"}`.

### POST `/api/mkdir`

Create a folder. Nested paths are created in one call (like `mkdir -p`).
Already-existing folders are a no-op (success).

```bash
curl -fsS -X POST "http://HOST:8000/api/mkdir" \
     -H "Content-Type: application/json" \
     -d '{"path":"docs/2026/invoices"}'
```

Response: `{"ok": true, "path": "docs/2026/invoices"}`.

### POST `/api/delete`

Delete a file, or a folder **and all its contents** (recursive). Cannot delete
the root. 404 if the path doesn't exist.

```bash
curl -fsS -X POST "http://HOST:8000/api/delete" \
     -H "Content-Type: application/json" \
     -d '{"path":"docs/old"}'
```

Response: `{"ok": true}`.

### POST `/api/rename`

Rename an item **in place** (same parent folder). `name` is the new basename —
it may not contain `/`, `.`, or `..`. Fails if the target name already exists.

```bash
curl -fsS -X POST "http://HOST:8000/api/rename" \
     -H "Content-Type: application/json" \
     -d '{"path":"docs/report.pdf","name":"report-final.pdf"}'
```

Response: `{"ok": true, "path": "docs/report-final.pdf"}`.

### POST `/api/move`

Move an item into a different **existing** folder (`dest` must be a folder; use
`""` for the root). Keeps the item's basename. Refuses to move a folder into
itself/a descendant, or onto an existing name in the destination.

```bash
curl -fsS -X POST "http://HOST:8000/api/move" \
     -H "Content-Type: application/json" \
     -d '{"path":"docs/report.pdf","dest":"archive"}'
```

Response: `{"ok": true, "path": "archive/report.pdf"}`.

### POST `/api/zip`

Stream a ZIP archive of one or more files/folders (folders are included
recursively). Accepts either JSON `{"paths": [...]}` or a form POST with
repeated `path=` fields. A single selected folder names the archive after it;
otherwise it's `mysharedbucket.zip`.

```bash
curl -fSL -X POST "http://HOST:8000/api/zip" \
     -H "Content-Type: application/json" \
     -d '{"paths":["docs","photos/cat.jpg"]}' \
     -o bundle.zip
```

`400` if the selection resolves to no files.

---

## Quick reference for scripting

```bash
HOST=myserver.local:8000

# upload
curl -fSL -T "$f" "http://$HOST/api/upload?path=$(python3 -c 'import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1],safe="/"))' "$dest")"

# make folder
curl -fsS -X POST "http://$HOST/api/mkdir" -H 'Content-Type: application/json' -d "{\"path\":\"$dir\"}"

# list (pipe through jq for readability)
curl -fsS "http://$HOST/api/list?path=$dir" | jq .
```

There is a convenience wrapper `upload.sh` (host normalization + URL-encoding)
in the repo, but it is gitignored as a local helper — re-create it from the
`/api/upload` section above if it's missing.

> **Security:** no auth by design. Run only on a trusted LAN; never expose to
> the internet.
