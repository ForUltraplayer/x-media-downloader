(() => {
  'use strict';

  const BTN_WRAP_CLASS = 'x-img-dl-btn-wrap';
  const BTN_CLASS = 'x-img-dl-btn';
  const EVENT_NAME = '__x_media_dl_data__';

  // tweetId -> [{ type: 'gif' | 'video', url, mediaId }]
  const tweetVideoCache = new Map();

  window.addEventListener(EVENT_NAME, (e) => {
    const map = e?.detail;
    if (!map || typeof map !== 'object') return;
    let updated = false;
    for (const [tweetId, items] of Object.entries(map)) {
      if (Array.isArray(items) && items.length > 0) {
        tweetVideoCache.set(tweetId, items);
        updated = true;
      }
    }
    if (updated) {
      requestAnimationFrame(() => scanAllTweets());
    }
  });

  function isInsideQuoteTweet(el, article) {
    let curr = el.parentElement;
    while (curr && curr !== article) {
      if (
        curr.getAttribute('role') === 'link' &&
        curr.querySelector('[data-testid="User-Name"]')
      ) {
        return true;
      }
      curr = curr.parentElement;
    }
    return false;
  }

  function toOriginalImageInfo(src) {
    try {
      const url = new URL(src);
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
      if (!mediaId) return null;

      let format = (url.searchParams.get('format') || extFromPath || 'jpg').toLowerCase();
      if (format === 'jpeg') format = 'jpg';

      const origUrl = `https://pbs.twimg.com/media/${mediaId}?format=${encodeURIComponent(format)}&name=orig`;
      return { type: 'image', url: origUrl, mediaId, ext: format };
    } catch {
      return null;
    }
  }

  function extractTweetImages(article) {
    const imgs = article.querySelectorAll('img[src*="pbs.twimg.com/media/"]');
    const seen = new Map();

    for (const img of imgs) {
      if (isInsideQuoteTweet(img, article)) continue;
      const info = toOriginalImageInfo(img.src);
      if (info && !seen.has(info.mediaId)) {
        seen.set(info.mediaId, info);
      }
    }

    return Array.from(seen.values());
  }

  function extractDomVideos(article) {
    const videos = article.querySelectorAll('video');
    const results = [];
    let hasUnresolvedVideo = false;

    for (let i = 0; i < videos.length; i++) {
      const video = videos[i];
      if (isInsideQuoteTweet(video, article)) continue;

      const src =
        video.currentSrc ||
        video.getAttribute('src') ||
        video.querySelector('source')?.getAttribute('src') ||
        '';

      if (src.includes('video.twimg.com/tweet_video/')) {
        const mediaId = src.split('/tweet_video/')[1]?.split('.')[0] || `gif_${i}`;
        results.push({ type: 'gif', url: src, mediaId });
        continue;
      }

      const poster = video.getAttribute('poster') || '';
      if (poster.includes('pbs.twimg.com/tweet_video_thumb/')) {
        const thumbId = poster.split('/tweet_video_thumb/')[1]?.split(/[.?]/)[0];
        if (thumbId) {
          results.push({
            type: 'gif',
            url: `https://video.twimg.com/tweet_video/${thumbId}.mp4`,
            mediaId: thumbId
          });
          continue;
        }
      }

      hasUnresolvedVideo = true;
    }

    const gifThumbs = article.querySelectorAll('img[src*="tweet_video_thumb/"]');
    for (const thumb of gifThumbs) {
      if (isInsideQuoteTweet(thumb, article)) continue;
      const thumbId = thumb.src.split('/tweet_video_thumb/')[1]?.split(/[.?]/)[0];
      if (thumbId && !results.some((r) => r.mediaId === thumbId)) {
        results.push({
          type: 'gif',
          url: `https://video.twimg.com/tweet_video/${thumbId}.mp4`,
          mediaId: thumbId
        });
      }
    }

    if (!hasUnresolvedVideo) {
      const videoContainers = article.querySelectorAll(
        '[data-testid="videoPlayer"], [data-testid="videoComponent"], [data-testid="playButton"], [data-testid="tweetPhoto"], img[src*="ext_tw_video_thumb/"], img[src*="amplify_video_thumb/"]'
      );
      for (const el of videoContainers) {
        if (!isInsideQuoteTweet(el, article)) {
          // tweetPhoto without a pbs.twimg.com/media image means video/GIF
          if (el.getAttribute('data-testid') === 'tweetPhoto' && el.querySelector('img[src*="pbs.twimg.com/media/"]')) {
            continue;
          }
          hasUnresolvedVideo = true;
          break;
        }
      }
    }

    return { domVideos: results, hasUnresolvedVideo };
  }

  function extractTweetMeta(article) {
    const links = article.querySelectorAll('a[href*="/status/"]');
    let fallbackMatch = null;

    for (const link of links) {
      if (isInsideQuoteTweet(link, article)) continue;
      const href = link.getAttribute('href') || '';
      const match = href.match(/^\/([^/]+)\/status\/(\d+)/);
      if (match) {
        if (link.querySelector('time')) {
          return { username: match[1], tweetId: match[2] };
        }
        if (!fallbackMatch) {
          fallbackMatch = { username: match[1], tweetId: match[2] };
        }
      }
    }

    if (fallbackMatch) return fallbackMatch;

    const pathMatch = window.location.pathname.match(/^\/([^/]+)\/status\/(\d+)/);
    if (pathMatch) {
      return { username: pathMatch[1], tweetId: pathMatch[2] };
    }

    return { username: 'unknown', tweetId: String(Date.now()) };
  }

  function getMediaSummary(article) {
    const images = extractTweetImages(article);
    const { tweetId } = extractTweetMeta(article);
    const cachedVideos = tweetVideoCache.get(tweetId) || [];
    const { domVideos, hasUnresolvedVideo } = extractDomVideos(article);

    const videoItems = cachedVideos.length > 0 ? cachedVideos : domVideos;
    const totalCount = images.length + (videoItems.length > 0 ? videoItems.length : hasUnresolvedVideo ? 1 : 0);

    return {
      images,
      videoItems,
      hasUnresolvedVideo,
      totalCount
    };
  }

  function findActionBar(article) {
    const groups = article.querySelectorAll('div[role="group"]');
    for (const group of groups) {
      if (isInsideQuoteTweet(group, article)) continue;
      if (
        group.querySelector('[data-testid="reply"]') ||
        group.querySelector('[data-testid="like"]') ||
        group.querySelector('[data-testid="unlike"]') ||
        group.querySelector('[data-testid="bookmark"]')
      ) {
        return group;
      }
    }
    return null;
  }

  function createIconSvg(state) {
    if (state === 'loading') {
      return `
        <svg viewBox="0 0 24 24" aria-hidden="true" class="x-img-dl-icon x-img-dl-spin">
          <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2.2" stroke-dasharray="42" stroke-dashoffset="14" stroke-linecap="round"/>
        </svg>
      `;
    }
    if (state === 'done') {
      return `
        <svg viewBox="0 0 24 24" aria-hidden="true" class="x-img-dl-icon">
          <path fill="currentColor" d="M9.55 18.2L4.35 13l1.4-1.4 3.8 3.8 8.7-8.7 1.4 1.4-10.1 10.1z"/>
        </svg>
      `;
    }
    if (state === 'error') {
      return `
        <svg viewBox="0 0 24 24" aria-hidden="true" class="x-img-dl-icon">
          <path fill="currentColor" d="M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2zm1 15h-2v-2h2zm0-4h-2V7h2z"/>
        </svg>
      `;
    }
    return `
      <svg viewBox="0 0 24 24" aria-hidden="true" class="x-img-dl-icon">
        <path fill="currentColor" d="M12 16.5l-5-5 1.41-1.41L11 12.67V3h2v9.67l2.59-2.58L17 11.5l-5 5zm-7 2.5h14v2H5v-2z"/>
      </svg>
    `;
  }

  function setButtonState(btn, state, countText = '') {
    btn.dataset.state = state;
    const iconBox = btn.querySelector('.x-img-dl-icon-box');
    const label = btn.querySelector('.x-img-dl-count');
    if (iconBox) {
      iconBox.innerHTML = createIconSvg(state);
    }
    if (label) {
      label.textContent = countText;
    }
  }

  function createDownloadButton(article, initialCount) {
    const wrap = document.createElement('div');
    wrap.className = BTN_WRAP_CLASS;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = BTN_CLASS;
    btn.title = `원본 미디어 다운로드 (${initialCount}개)`;
    btn.setAttribute('aria-label', '원본 미디어 다운로드');
    btn.dataset.state = 'idle';

    const iconBox = document.createElement('span');
    iconBox.className = 'x-img-dl-icon-box';
    iconBox.innerHTML = createIconSvg('idle');

    const countSpan = document.createElement('span');
    countSpan.className = 'x-img-dl-count';
    countSpan.textContent = initialCount > 1 ? String(initialCount) : '';

    btn.appendChild(iconBox);
    btn.appendChild(countSpan);

    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();

      if (btn.dataset.state === 'loading') return;

      const { username, tweetId } = extractTweetMeta(article);
      let { images, videoItems, hasUnresolvedVideo } = getMediaSummary(article);

      setButtonState(btn, 'loading', '...');

      try {
        if (videoItems.length === 0 && hasUnresolvedVideo) {
          const fallback = await chrome.runtime.sendMessage({
            type: 'FETCH_SYNDICATION_MEDIA',
            tweetId
          });
          if (fallback?.ok && Array.isArray(fallback.items) && fallback.items.length > 0) {
            videoItems = fallback.items;
            tweetVideoCache.set(tweetId, videoItems);
          }
        }

        const allItems = [...images, ...videoItems];
        if (allItems.length === 0) {
          setButtonState(btn, 'error', '0');
          btn.title = '미디어 주소를 찾을 수 없습니다 (페이지를 새로고침 후 다시 시도해보세요)';
          setTimeout(() => setButtonState(btn, 'idle', ''), 2500);
          return;
        }

        const hasGif = videoItems.some((v) => v.type === 'gif');
        setButtonState(btn, 'loading', hasGif ? 'GIF' : String(allItems.length));

        const res = await chrome.runtime.sendMessage({
          type: 'DOWNLOAD_MEDIA',
          items: allItems,
          username,
          tweetId
        });

        if (res && res.ok) {
          setButtonState(btn, 'done', `${res.started}/${res.total}`);
          btn.title = `다운로드 완료 (${res.started}개)`;
          setTimeout(() => {
            setButtonState(btn, 'idle', allItems.length > 1 ? String(allItems.length) : '');
            btn.title = `원본 미디어 다운로드 (${allItems.length}개)`;
          }, 2500);
        } else {
          setButtonState(btn, 'error', '!');
          btn.title = res?.error || '다운로드 실패';
          setTimeout(() => {
            setButtonState(btn, 'idle', allItems.length > 1 ? String(allItems.length) : '');
            btn.title = `원본 미디어 다운로드 (${allItems.length}개)`;
          }, 2500);
        }
      } catch (err) {
        console.error('[X-MEDIA-DL] sendMessage failed:', err);
        setButtonState(btn, 'error', '!');
        btn.title = '확장프로그램 연결 오류 (페이지를 새로고침 해주세요)';
        setTimeout(() => {
          setButtonState(btn, 'idle', '');
        }, 3000);
      }
    });

    wrap.appendChild(btn);
    return wrap;
  }

  function processTweet(article) {
    if (!article || article.nodeType !== Node.ELEMENT_NODE) return;

    const actionBar = findActionBar(article);
    if (!actionBar) return;

    const existing = actionBar.querySelector(`.${BTN_WRAP_CLASS}`);
    const { totalCount } = getMediaSummary(article);

    if (existing) {
      const btn = existing.querySelector(`.${BTN_CLASS}`);
      if (btn && btn.dataset.state === 'idle') {
        const countEl = btn.querySelector('.x-img-dl-count');
        if (countEl) {
          countEl.textContent = totalCount > 1 ? String(totalCount) : '';
        }
        btn.title = `원본 미디어 다운로드 (${totalCount}개)`;
      }
      return;
    }

    if (totalCount === 0) return;

    const btnWrap = createDownloadButton(article, totalCount);
    actionBar.appendChild(btnWrap);
  }

  function scanAllTweets(root = document) {
    const articles = root.querySelectorAll('article[data-testid="tweet"]');
    for (const article of articles) {
      processTweet(article);
    }
  }

  let scheduled = false;
  const pendingArticles = new Set();

  function scheduleFlush() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      for (const article of pendingArticles) {
        if (article.isConnected) {
          processTweet(article);
        }
      }
      pendingArticles.clear();
    });
  }

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue;

        if (node.matches && node.matches('article[data-testid="tweet"]')) {
          pendingArticles.add(node);
        } else {
          const parentTweet = node.closest?.('article[data-testid="tweet"]');
          if (parentTweet) {
            pendingArticles.add(parentTweet);
          }
          if (node.querySelectorAll) {
            const nested = node.querySelectorAll('article[data-testid="tweet"]');
            for (const item of nested) {
              pendingArticles.add(item);
            }
          }
        }
      }
    }
    if (pendingArticles.size > 0) {
      scheduleFlush();
    }
  });

  scanAllTweets();
  observer.observe(document.body, { childList: true, subtree: true });
  setInterval(() => scanAllTweets(), 1500);
})();
