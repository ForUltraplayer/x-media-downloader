(() => {
  'use strict';

  const EVENT_NAME = '__x_media_dl_data__';

  function pickBestMp4(videoInfo) {
    const variants = videoInfo?.variants;
    if (!Array.isArray(variants)) return null;

    const mp4s = variants
      .filter((v) => v && v.content_type === 'video/mp4' && typeof v.url === 'string')
      .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));

    return mp4s[0]?.url || null;
  }

  function toOriginalPhotoInfo(mediaUrlHttps, fallbackId) {
    try {
      const url = new URL(mediaUrlHttps);
      if (!url.hostname.endsWith('twimg.com') || !url.pathname.includes('/media/')) {
        return null;
      }

      const rawSegment = url.pathname.split('/media/')[1]?.split('/')[0] || '';
      const cleanSegment = rawSegment.split(':')[0];
      const dotIdx = cleanSegment.lastIndexOf('.');

      let mediaId = cleanSegment;
      let extFromPath = '';
      if (dotIdx > 0) {
        mediaId = cleanSegment.slice(0, dotIdx);
        extFromPath = cleanSegment.slice(dotIdx + 1).toLowerCase();
      }
      if (!mediaId) mediaId = String(fallbackId || '');
      if (!mediaId) return null;

      let format = (url.searchParams.get('format') || extFromPath || 'jpg').toLowerCase();
      if (format === 'jpeg') format = 'jpg';

      return {
        type: 'image',
        url: `https://pbs.twimg.com/media/${mediaId}?format=${encodeURIComponent(format)}&name=orig`,
        mediaId,
        ext: format
      };
    } catch {
      return null;
    }
  }

  function extractFromTweetObj(tweetObj, outMap) {
    const tweetId = tweetObj?.rest_id || tweetObj?.id_str;
    if (!tweetId) return;

    const mediaList =
      tweetObj?.legacy?.extended_entities?.media ||
      tweetObj?.extended_entities?.media;

    const articleMediaList =
      tweetObj?.article?.article_results?.result?.media_entities;

    const items = [];
    const seenIds = new Set();

    if (Array.isArray(mediaList)) {
      for (let i = 0; i < mediaList.length; i++) {
        const m = mediaList[i];
        if (!m) continue;

        if (m.type === 'photo' && typeof m.media_url_https === 'string') {
          const info = toOriginalPhotoInfo(m.media_url_https, m.id_str || `${tweetId}_img_${i}`);
          if (info && !seenIds.has(info.mediaId)) {
            seenIds.add(info.mediaId);
            items.push(info);
          }
        } else if (m.type === 'animated_gif' || m.type === 'video') {
          const mp4Url = pickBestMp4(m.video_info);
          const mediaId = m.id_str || `${tweetId}_vid_${i}`;
          if (mp4Url && !seenIds.has(mediaId)) {
            seenIds.add(mediaId);
            items.push({
              type: m.type === 'animated_gif' ? 'gif' : 'video',
              url: mp4Url,
              mediaId
            });
          }
        }
      }
    }

    if (Array.isArray(articleMediaList)) {
      for (let i = 0; i < articleMediaList.length; i++) {
        const entry = articleMediaList[i];
        const origImg = entry?.media_info?.original_img_url;
        if (typeof origImg === 'string') {
          const info = toOriginalPhotoInfo(origImg, entry.media_id || `${tweetId}_art_${i}`);
          if (info && !seenIds.has(info.mediaId)) {
            seenIds.add(info.mediaId);
            items.push(info);
          }
        }
      }
    }

    if (items.length > 0) {
      outMap[tweetId] = items;
    }
  }

  function walkJson(node, outMap, visited = new Set()) {
    if (!node || typeof node !== 'object') return;
    if (visited.has(node)) return;
    visited.add(node);

    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) {
        walkJson(node[i], outMap, visited);
      }
      return;
    }

    if (
      (node.rest_id || node.id_str) &&
      (node.legacy?.extended_entities?.media ||
        node.extended_entities?.media ||
        node.article?.article_results?.result?.media_entities)
    ) {
      extractFromTweetObj(node, outMap);
    }

    const keys = Object.keys(node);
    for (let i = 0; i < keys.length; i++) {
      const val = node[keys[i]];
      if (val && typeof val === 'object') {
        walkJson(val, outMap, visited);
      }
    }
  }

  function processApiText(text) {
    try {
      const json = JSON.parse(text);
      const outMap = {};
      walkJson(json, outMap);
      if (Object.keys(outMap).length > 0) {
        window.dispatchEvent(new CustomEvent(EVENT_NAME, { detail: outMap }));
      }
    } catch {
      // Ignore non-JSON or partial responses
    }
  }

  function isTargetApiUrl(url) {
    if (typeof url !== 'string') return false;
    return url.includes('/i/api/') || url.includes('/graphql/');
  }

  const origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = async function (...args) {
      const response = await origFetch.apply(this, args);
      try {
        const reqUrl = typeof args[0] === 'string' ? args[0] : args[0]?.url;
        if (isTargetApiUrl(reqUrl)) {
          const clone = response.clone();
          clone.text().then(processApiText).catch(() => {});
        }
      } catch {
        // Ignore hook errors
      }
      return response;
    };
  }

  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__xMediaDlUrl = typeof url === 'string' ? url : String(url || '');
    return origOpen.apply(this, [method, url, ...rest]);
  };

  XMLHttpRequest.prototype.send = function (...args) {
    if (isTargetApiUrl(this.__xMediaDlUrl)) {
      this.addEventListener('load', function () {
        try {
          if (this.responseType === '' || this.responseType === 'text') {
            processApiText(this.responseText);
          } else if (this.responseType === 'json' && this.response) {
            const outMap = {};
            walkJson(this.response, outMap);
            if (Object.keys(outMap).length > 0) {
              window.dispatchEvent(new CustomEvent(EVENT_NAME, { detail: outMap }));
            }
          }
        } catch {
          // Ignore hook errors
        }
      });
    }
    return origSend.apply(this, args);
  };
})();
