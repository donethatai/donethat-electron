const shell = { openExternal: window.electronAPI.openExternal };

function parseInternalView(url) {
  try {
    if (url.startsWith('donethat://')) {
      // For donethat:// URLs, extract the hostname as the view
      const u = new URL(url);
      
      // For donethat:// URLs, the hostname should be the view
      // If hostname is empty, try to extract from the full URL
      let view = u.hostname;
      if (!view) {
        // Try to extract view from the URL after the protocol
        const match = url.match(/^donethat:\/\/([^\/]+)/);
        view = match ? match[1] : 'dashboard';
      }
      return view;
    }
    return (url || '').replace(/^\/?(app:)?/, '') || 'dashboard';
  } catch (e) {
    return 'dashboard';
  }
}

function routeLink(url, opts = {}) {
  const { source = 'unknown' } = opts;
  if (!url) return { ok: false, reason: 'empty' };

  // Clean up URL - remove any HTML tags or extra characters
  url = url.replace(/<\/?[^>]*>/g, '').trim();

  try {
    // All donethat:// URLs are internal by default
    const isInternal = url.startsWith('donethat://');
    
    if (isInternal) {
      const view = parseInternalView(url);
      
      // For internal links, always open the main overlay
      try { window.electronAPI?.send?.('overlay:open-main', view) } catch (_) {}
      
      return { ok: true, type: 'internal', view };
    }

    shell.openExternal(url);
    return { ok: true, type: 'external' };
  } catch (e) {
    console.error('[routeLink] error', source, e);
    return { ok: false, error: e?.message };
  }
}

// Export for both CommonJS and Browser
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { routeLink };
} else {
  window.routeLink = routeLink;
}


