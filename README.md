# Cassette Browser

> [!IMPORTANT]
> This is a toy project and not intended for production use.

[Live site](https://apljungquist.github.io/cassette-browser/)

A static web app for comparing HTTP cassettes recorded against AXIS devices across firmware versions.

## Local development

Serve the repo root with any static file server:

```
python3 -m http.server
```

Open `http://localhost:8000`. The app fetches cassette data at runtime from GitHub — no local checkout of the cassettes repo is needed.

## Configuration

Edit `config.json` to point at a different cassettes repo.

## Deployment

Push to `main` — the GitHub Actions workflow deploys to GitHub Pages automatically.
