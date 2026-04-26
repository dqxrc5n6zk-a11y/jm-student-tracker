function renderVideoViewerPage_(e) {
  const src = String((e && e.parameter && e.parameter.src) || "").trim();
  const name = String((e && e.parameter && e.parameter.name) || "Run Video").trim();

  if (!src) {
    return HtmlService
      .createHtmlOutput("<h2>Missing video source.</h2>")
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  }

  const html = `
    <!doctype html>
    <html>
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>${name.replace(/</g, "&lt;").replace(/>/g, "&gt;")}</title>
        <style>
          body {
            margin: 0;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
            background: #111827;
            color: #f9fafb;
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
          }
          .wrap {
            width: min(960px, 100%);
            padding: 20px;
            box-sizing: border-box;
          }
          .card {
            background: #1f2937;
            border-radius: 18px;
            padding: 18px;
            box-shadow: 0 20px 50px rgba(0, 0, 0, 0.35);
          }
          h1 {
            margin: 0 0 14px;
            font-size: 22px;
          }
          video {
            width: 100%;
            max-height: 80vh;
            border-radius: 12px;
            background: #000;
          }
          a {
            color: #93c5fd;
          }
          .meta {
            margin-top: 12px;
            font-size: 14px;
            color: #d1d5db;
          }
        </style>
      </head>
      <body>
        <div class="wrap">
          <div class="card">
            <h1>${name.replace(/</g, "&lt;").replace(/>/g, "&gt;")}</h1>
            <video controls autoplay playsinline preload="metadata" src="${src.replace(/"/g, "&quot;")}"></video>
            <div class="meta">
              If the video does not start, <a href="${src.replace(/"/g, "&quot;")}" target="_blank" rel="noreferrer">open the raw file</a>.
            </div>
          </div>
        </div>
      </body>
    </html>
  `;

  return HtmlService
    .createHtmlOutput(html)
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

// Add this at the top of your existing doGet(e):
//
// function doGet(e) {
//   if (e && e.parameter && e.parameter.view === "video") {
//     return renderVideoViewerPage_(e);
//   }
//
//   const action = e.parameter.action;
//   ...
// }
