# weatherDashboard

Single-page dashboard for the Campbell CR1000X weather station, hosted on GitHub Pages.

- Data comes from the Google Sheet that `cr1000x.py` fills with 15-minute values. Only the last ~3 months are requested, filtered on Google's side through the sheet's query endpoint.
- The data is cached in the browser, so repeat visits draw instantly and only download rows newer than the cache.
- Charts use [uPlot](https://github.com/leeoniya/uPlot) (about 23 KB) loaded from jsDelivr. There is no build step: `index.html`, `styles.css` and `app.js` are served as they are.
- The time range can be set in the link: `#1d`, `#7d`, `#30d` or `#90d`.

The page finds columns by their header names in the sheet (see `COLUMNS` in `app.js`). Renaming a header in the sheet means updating that list as well.

To preview locally, serve the folder (for example `python -m http.server`) and open http://localhost:8000.
