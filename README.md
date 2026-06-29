# my shared bucket

A tiny, dependency-free Dropbox-style file drop for a **trusted local network**.
Drag files or whole folders onto the page, watch the progress, click to download.
No accounts, no agent, no cloud — files live on the server's local disk.

> **Security note:** there is no authentication. Run this only on a LAN you
> trust. Don't port-forward it to the internet.

## What it does

- Drag-and-drop upload of files **and folders** (folder structure is preserved)
- Live per-file upload progress; large files stream straight to disk
- Browse folders, create folders, rename, delete, one-click download
- **Move** files: drag a row onto a folder/breadcrumb, or tap **Move to…**
  (a folder picker — works on touch devices where dragging doesn't)
- Multi-select with checkboxes to bulk-download as a ZIP or bulk-delete
- Shows disk usage; works on phones and tablets too
- Pure Python standard library — nothing to `pip install`

## Requirements

- Ubuntu 24.04 (or anything with Python 3.10+)
- That's it.

## Quick start (try it now)

```bash
python3 app.py
```

Then open the printed `network:` URL from any device on your LAN.
Override defaults with environment variables:

```bash
SHARE_DIR=/srv/bucket PORT=8080 python3 app.py
```

| Variable     | Default        | Meaning                                   |
|--------------|----------------|-------------------------------------------|
| `SHARE_DIR`  | `./storage`    | where uploaded files are stored           |
| `HOST`       | `0.0.0.0`      | bind address (all interfaces)             |
| `PORT`       | `8000`         | port                                      |
| `MAX_UPLOAD` | `0` (no limit) | max upload size in bytes, `0` = unlimited |

## Run it always-on (systemd)

From the project directory on the server:

```bash
./install.sh
```

This installs and starts a `mysharedbucket` systemd service that launches on
boot and restarts on failure. Useful commands:

```bash
sudo systemctl status mysharedbucket
sudo systemctl restart mysharedbucket
journalctl -u mysharedbucket -f          # live logs
```

To change the storage location or port, edit the `Environment=` lines in
`/etc/systemd/system/mysharedbucket.service`, then
`sudo systemctl daemon-reload && sudo systemctl restart mysharedbucket`.

## Firewall

If `ufw` is enabled, allow the port on your LAN, e.g.:

```bash
sudo ufw allow from 192.168.0.0/16 to any port 8000 proto tcp
```

## Files

| File                       | Purpose                                  |
|----------------------------|------------------------------------------|
| `app.py`                   | the whole server (stdlib only)           |
| `static/`                  | the web interface (HTML/CSS/JS)          |
| `mysharedbucket.service`   | systemd unit template                    |
| `install.sh`               | one-shot installer                       |
| `storage/`                 | uploaded files (created on first run)    |

## How uploads work

The browser sends each file as the **raw body** of a `PUT /api/upload` request
and the server streams it to disk in 1 MiB chunks. There's no in-memory
multipart buffering, so uploading multi-gigabyte files is fine. Dropped folders
are walked in the browser and re-created server-side from each file's relative
path.
