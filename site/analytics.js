// Website analytics only: previews and automatic language redirects send no hits.
(function () {
  if (location.protocol !== 'https:' ||
      !['rach3.com', 'www.rach3.com'].includes(location.hostname) ||
      window.rach3SiteRedirecting) return;

  var measurementId = document.currentScript.dataset.measurementId;
  if (!/^G-[A-Z0-9]+$/.test(measurementId || '')) return;

  window.dataLayer = window.dataLayer || [];
  window.gtag = function () { window.dataLayer.push(arguments); };
  window.gtag('js', new Date());
  window.gtag('config', measurementId);

  var tag = document.createElement('script');
  tag.async = true;
  tag.src = 'https://www.googletagmanager.com/gtag/js?id=' + measurementId;
  document.head.appendChild(tag);

  // Count the installer link activation, never claim a completed download.
  // Use a distinct event so GA4 enhanced measurement cannot double-count it.
  function downloadClick(event) {
    if (event.type === 'auxclick' && event.button !== 1) return;
    var link = event.target.closest && event.target.closest('a[data-download-platform]');
    if (!link) return;
    var fileName = new URL(link.href).pathname.split('/').pop();
    window.gtag('event', 'download_click', {
      send_to: measurementId,
      download_platform: link.dataset.downloadPlatform,
      release_version: link.dataset.releaseVersion,
      site_language: document.documentElement.lang,
      file_name: fileName,
      file_extension: fileName.split('.').pop(),
      link_url: link.href
    });
  }
  document.addEventListener('click', downloadClick);
  document.addEventListener('auxclick', downloadClick);
})();
