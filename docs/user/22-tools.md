---
section: Extending
---
# Videos, PDFs and images

Claude can make a video, a PDF or a batch of images in any session when the tools below are on the
computer. On a Linux server, the installer installs them in the background (`pilot deps list` shows them,
`pilot deps update` installs them again); the local macOS setup (`scripts/dev-local.sh`) installs none of them.
Verified on Debian 12 and Ubuntu 24.04 (arm64) installed from this repository: the installer brought every tool below,
then `pilot pdf`, `scrapling extract get` and `fetch`, and the render of a new `pilot video new` project (a 5-second
1080p MP4) worked. Not yet verified on x86_64. Without
them, `pilot video new` and `pilot pdf` stop and say what is missing; the `image-edit` skill works as soon as you
install ImageMagick and ffmpeg yourself (for example with Homebrew).

| Tool | Used for |
|---|---|
| Node.js 22 + **Remotion** | motion design videos written in React (skill `video-motion-design`) |
| Chromium (one for everything) | HTML -> PDF (`pilot pdf`, skill `pdf-document`), video renders and Scrapling share the same browser |
| ImageMagick, ffmpeg | resize, convert, compress, thumbnails (skill `image-edit`) |
| poppler-utils | read and preview PDFs (`pdftotext`, `pdftoppm`) |
| **Scrapling** + Chromium | web scraping: static, JavaScript and protected pages -> Markdown, CSV, JSON (skill `web-scraping`) |
| zip, unzip, jq, ripgrep | archives (exports, imports), JSON, fast search |

## Videos

Ask "make a 20-second vertical video announcing our summer sale". Claude creates a project
(`pilot video new <topic>/videos/<name>`), writes the scenes, checks a few frames, renders an MP4
and gives you its path (open it in Files). Remotion is installed once in
`<state>/tools/remotion` (`/var/lib/claude-maxxing` on a Linux server); each project links to it, so it takes a second to create
and weighs a few MB.

## PDFs

Ask "make a PDF quote for …" or "turn this report into a nice PDF": Claude writes an HTML page and
prints it with `pilot pdf page.html page.pdf` (A4, backgrounds, your fonts).

## Web scraping

Ask "collect the name and price of every product on this site into a CSV" or "tell me every morning
if this page changes". Claude uses Scrapling: `scrapling extract get|fetch|stealthy-fetch URL out.md`
for one page (plain HTTP, or a real browser for JavaScript pages), or a short Python script run with
`scrapling-python` for structured data over several pages. Results land in the topic (`data/`),
with the script, so the job can be re-run or scheduled. It respects `robots.txt` and goes slowly by
default; personal or login-protected data only with your explicit say-so. No MCP server is added
(it would cost context in every session): Claude calls the command line.
On a Linux server, installed in `/var/lib/claude-maxxing/tools/scrapling` (every package pinned with its checksum) and `tools/browsers` (Chromium, shared with videos and PDFs), ~750 MB.

## Images and SEO

`image-edit` covers resizing, webp conversion, compression, crops, thumbnails and contact sheets,
one file or whole folders. `seo-audit` checks a website for real (robots.txt, sitemap, titles,
descriptions, headings, canonical, Open Graph, Core Web Vitals through PageSpeed) and writes a
prioritized report in the topic.

## Check or repair

```bash
pilot video status                          # Node.js, Remotion, headless browser, Scrapling
pilot deps list                             # versions of every component
pilot deps update                           # (re)install the tools, as root (Linux server only)
```
Only one update of the tools runs at a time: a `pilot deps update` started while another one runs (for example the
one in the background after an installation or `pilot update`) says it waits, then goes on. `pilot doctor` warns
(never fails) when they are missing. `pilot deps update` downloads Linux builds and needs
root: it does not install anything in the local macOS setup.
