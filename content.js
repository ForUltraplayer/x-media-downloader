(() => {
  'use strict';

  const BTN_WRAP_CLASS = 'x-img-dl-btn-wrap';
  const BTN_CLASS = 'x-img-dl-btn';
  const EVENT_NAME = '__x_media_dl_data__';

  // Loaded before this file via manifest content_scripts (same isolated world).
  const { DEFAULT_SETTINGS, normalizePresets, pickActivePresetId } = XMediaSettings;

  let userSettings = {
    presets: DEFAULT_SETTINGS.presets,
    activePresetId: DEFAULT_SETTINGS.activePresetId,
    clickMode: DEFAULT_SETTINGS.clickMode,
    rememberPreset: DEFAULT_SETTINGS.rememberPreset,
    folderPath: DEFAULT_SETTINGS.folderPath
  };

  // tweetId -> [{ type: 'image' | 'gif' | 'video', url, mediaId, ext? }]
  const tweetMediaCache = new Map();

  function applySettings(stored) {
    const presets = normalizePresets(stored);
    userSettings = {
      presets,
      activePresetId: pickActivePresetId(presets, stored.activePresetId),
      clickMode: stored.clickMode === 'always_menu' ? 'always_menu' : 'instant_hover',
      rememberPreset: Boolean(stored.rememberPreset),
      folderPath: stored.folderPath ?? DEFAULT_SETTINGS.folderPath
    };
  }

  function getActivePreset() {
    return (
      userSettings.presets.find((p) => p.id === userSettings.activePresetId) ||
      userSettings.presets[0]
    );
  }

  async function loadInitialSettings() {
    try {
      const stored = await chrome.storage.sync.get(DEFAULT_SETTINGS);
      applySettings(stored);
      refreshButtonTooltips();
    } catch {
      // Ignore if storage unavailable
    }
  }

  try {
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== 'sync') return;
      const merged = { ...userSettings };
      if (changes.presets) merged.presets = changes.presets.newValue;
      if (changes.activePresetId) merged.activePresetId = changes.activePresetId.newValue;
      if (changes.clickMode) merged.clickMode = changes.clickMode.newValue;
      if (changes.rememberPreset) merged.rememberPreset = changes.rememberPreset.newValue;
      if (changes.folderPath) merged.folderPath = changes.folderPath.newValue;
      applySettings(merged);
      refreshButtonTooltips();
    });
  } catch {
    // Ignore if runtime unavailable
  }

  window.addEventListener(EVENT_NAME, (e) => {
    const map = e?.detail;
    if (!map || typeof map !== 'object') return;
    let updated = false;
    // Any script on the page can dispatch this event. Drop malformed entries so the
    // DOM code below cannot throw; URL/host checks happen in background.js before download.
    for (const [tweetId, items] of Object.entries(map)) {
      const wellFormed = Array.isArray(items)
        ? items.filter((item) => item && typeof item.url === 'string')
        : [];
      if (wellFormed.length > 0) {
        tweetMediaCache.set(tweetId, wellFormed);
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

  function hasMoreImagesBadge(article) {
    const photos = article.querySelectorAll('[data-testid="tweetPhoto"], a[href*="/photo/"]');
    for (const el of photos) {
      if (isInsideQuoteTweet(el, article)) continue;
      const text = (el.textContent || '').trim();
      if (/^\+\d+$/.test(text)) {
        return true;
      }
    }
    return false;
  }

  function getMediaSummary(article) {
    const domImages = extractTweetImages(article);
    const { tweetId } = extractTweetMeta(article);
    const apiItems = tweetMediaCache.get(tweetId) || [];
    const { domVideos, hasUnresolvedVideo } = extractDomVideos(article);

    const mergedMap = new Map();
    for (const item of apiItems) {
      if (item && item.mediaId && !mergedMap.has(item.mediaId)) {
        mergedMap.set(item.mediaId, item);
      }
    }
    for (const img of domImages) {
      if (img && img.mediaId && !mergedMap.has(img.mediaId)) {
        mergedMap.set(img.mediaId, img);
      }
    }

    const hasApiVideo = apiItems.some((item) => item.type === 'video' || item.type === 'gif');
    if (!hasApiVideo) {
      for (const vid of domVideos) {
        if (vid && vid.mediaId && !mergedMap.has(vid.mediaId)) {
          mergedMap.set(vid.mediaId, vid);
        }
      }
    }

    const allItems = Array.from(mergedMap.values());
    const hasResolvedVideo = allItems.some((item) => item.type === 'video' || item.type === 'gif');
    const needsVideoFallback = hasUnresolvedVideo && !hasResolvedVideo;
    const needsMoreFallback = !tweetMediaCache.has(tweetId) && hasMoreImagesBadge(article);
    const totalCount = allItems.length + (needsVideoFallback ? 1 : 0);

    return {
      allItems,
      needsFallback: needsVideoFallback || needsMoreFallback,
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

  function buildIdleTooltip(count) {
    const active = getActivePreset();
    const presetName = active ? active.name : '기본';
    if (userSettings.clickMode === 'always_menu' && userSettings.presets.length > 1) {
      return `원본 미디어 다운로드 (${count}개) · 클릭해 폴더 선택`;
    }
    if (userSettings.presets.length > 1) {
      return `원본 미디어 다운로드 (${count}개) · 클릭: [${presetName}] / 호버·우클릭: 폴더 변경`;
    }
    return `원본 미디어 다운로드 (${count}개) · [${presetName}]`;
  }

  function refreshButtonTooltips() {
    const buttons = document.querySelectorAll(`.${BTN_CLASS}`);
    for (const btn of buttons) {
      if (btn.dataset.state === 'idle') {
        const count = Number(btn.dataset.mediaCount || 1);
        btn.title = buildIdleTooltip(count);
      }
    }
  }

  async function triggerDownload(article, btn, preset) {
    if (btn.dataset.state === 'loading') return;

    const { username, tweetId } = extractTweetMeta(article);
    let { allItems, needsFallback } = getMediaSummary(article);

    setButtonState(btn, 'loading', '...');

    try {
      if (!chrome?.runtime?.id || typeof chrome.runtime.sendMessage !== 'function') {
        setButtonState(btn, 'error', '↻');
        btn.title = '확장프로그램이 업데이트되었습니다. 이 X.com 페이지를 새로고침(F5) 해주세요.';
        setTimeout(() => {
          setButtonState(btn, 'idle', '');
        }, 3000);
        return;
      }

      if (needsFallback) {
        const fallback = await chrome.runtime.sendMessage({
          type: 'FETCH_SYNDICATION_MEDIA',
          tweetId
        });
        if (fallback?.ok && Array.isArray(fallback.items) && fallback.items.length > 0) {
          tweetMediaCache.set(tweetId, fallback.items);
          allItems = getMediaSummary(article).allItems;
        }
      }

      if (allItems.length === 0) {
        setButtonState(btn, 'error', '0');
        btn.title = '미디어 주소를 찾을 수 없습니다 (페이지를 새로고침 후 다시 시도해보세요)';
        setTimeout(() => setButtonState(btn, 'idle', ''), 2500);
        return;
      }

      const hasGif = allItems.some((v) => v.type === 'gif');
      setButtonState(btn, 'loading', hasGif ? 'GIF' : String(allItems.length));

      const chosenPreset = preset || getActivePreset();
      const folderPath = chosenPreset ? chosenPreset.folderPath : userSettings.folderPath;

      const res = await chrome.runtime.sendMessage({
        type: 'DOWNLOAD_MEDIA',
        items: allItems,
        folderPath,
        username,
        tweetId
      });

      if (res && res.ok) {
        setButtonState(btn, 'done', `${res.started}/${res.total}`);
        btn.title = `[${chosenPreset?.name || '기본'}] 저장 완료 (${res.started}개)`;
        setTimeout(() => {
          btn.dataset.mediaCount = String(allItems.length);
          setButtonState(btn, 'idle', allItems.length > 1 ? String(allItems.length) : '');
          btn.title = buildIdleTooltip(allItems.length);
        }, 2200);
      } else {
        setButtonState(btn, 'error', '!');
        btn.title = res?.error || '다운로드 실패';
        setTimeout(() => {
          setButtonState(btn, 'idle', allItems.length > 1 ? String(allItems.length) : '');
          btn.title = buildIdleTooltip(allItems.length);
        }, 2500);
      }
    } catch (err) {
      console.warn('[X-MEDIA-DL] sendMessage failed:', err);
      setButtonState(btn, 'error', '↻');
      btn.title = '확장프로그램 연결이 끊겼습니다. 페이지를 새로고침(F5) 해주세요.';
      setTimeout(() => {
        setButtonState(btn, 'idle', '');
      }, 3000);
    }
  }

  // Shared floating preset popover
  let popoverEl = null;
  let popoverAnchorBtn = null;
  let popoverAnchorArticle = null;
  let popoverAnchorTop = 0;
  let popoverPinned = false;
  let openTimer = null;
  let closeTimer = null;

  function clearPopoverTimers() {
    if (openTimer) {
      clearTimeout(openTimer);
      openTimer = null;
    }
    if (closeTimer) {
      clearTimeout(closeTimer);
      closeTimer = null;
    }
  }

  function ensurePopover() {
    if (popoverEl && popoverEl.isConnected) return popoverEl;

    popoverEl = document.createElement('div');
    popoverEl.className = 'x-img-dl-popover';
    popoverEl.setAttribute('role', 'menu');

    const title = document.createElement('div');
    title.className = 'x-img-dl-popover-title';
    title.textContent = '저장 폴더 선택';

    const list = document.createElement('div');
    list.className = 'x-img-dl-popover-list';

    popoverEl.appendChild(title);
    popoverEl.appendChild(list);

    popoverEl.addEventListener('mouseenter', () => {
      if (closeTimer) {
        clearTimeout(closeTimer);
        closeTimer = null;
      }
    });

    popoverEl.addEventListener('mouseleave', () => {
      if (!popoverPinned) {
        scheduleClosePopover(160);
      }
    });

    document.body.appendChild(popoverEl);
    return popoverEl;
  }

  function closePopover() {
    clearPopoverTimers();
    if (popoverEl) {
      popoverEl.classList.remove('is-open');
    }
    popoverAnchorBtn = null;
    popoverAnchorArticle = null;
    popoverPinned = false;
  }

  function scheduleClosePopover(delay = 180) {
    if (closeTimer) clearTimeout(closeTimer);
    closeTimer = setTimeout(() => {
      closePopover();
    }, delay);
  }

  function openPopover(article, btn, pinned) {
    clearPopoverTimers();
    const pop = ensurePopover();
    const titleEl = pop.querySelector('.x-img-dl-popover-title');
    if (titleEl) {
      titleEl.textContent =
        userSettings.presets.length <= 1
          ? '저장 폴더 선택 (팝업에서 +추가 가능)'
          : '저장 폴더 선택';
    }
    const list = pop.querySelector('.x-img-dl-popover-list');
    list.innerHTML = '';

    popoverAnchorBtn = btn;
    popoverAnchorArticle = article;
    popoverAnchorTop = btn.getBoundingClientRect().top;
    popoverPinned = pinned;

    userSettings.presets.forEach((preset) => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'x-img-dl-preset-item';
      if (preset.id === userSettings.activePresetId) {
        item.classList.add('is-active');
      }

      const main = document.createElement('span');
      main.className = 'x-img-dl-preset-main';

      const dot = document.createElement('span');
      dot.className = 'x-img-dl-preset-dot';

      const name = document.createElement('span');
      name.className = 'x-img-dl-preset-name';
      name.textContent = preset.folderPath || '다운로드(기본)';

      main.appendChild(dot);
      main.appendChild(name);

      item.appendChild(main);

      item.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();

        const targetArticle = popoverAnchorArticle;
        const targetBtn = popoverAnchorBtn;
        closePopover();

        if (userSettings.rememberPreset && preset.id !== userSettings.activePresetId) {
          userSettings.activePresetId = preset.id;
          userSettings.folderPath = preset.folderPath;
          refreshButtonTooltips();
          try {
            await chrome.storage.sync.set({
              activePresetId: preset.id,
              folderPath: preset.folderPath
            });
          } catch {
            // Ignore storage write error
          }
        }

        if (targetArticle && targetBtn) {
          triggerDownload(targetArticle, targetBtn, preset);
        }
      });

      list.appendChild(item);
    });

    pop.style.visibility = 'hidden';
    pop.classList.add('is-open');

    const btnRect = btn.getBoundingClientRect();
    const popRect = pop.getBoundingClientRect();
    const margin = 8;

    let left = btnRect.left + btnRect.width / 2 - popRect.width / 2;
    left = Math.max(margin, Math.min(left, window.innerWidth - popRect.width - margin));

    let top = btnRect.top - popRect.height - 6;
    if (top < margin) {
      top = Math.min(btnRect.bottom + 6, window.innerHeight - popRect.height - margin);
    }

    pop.style.left = `${Math.round(left)}px`;
    pop.style.top = `${Math.round(top)}px`;
    pop.style.visibility = 'visible';
  }

  document.addEventListener('pointerdown', (e) => {
    if (!popoverEl || !popoverEl.classList.contains('is-open')) return;
    if (e.target instanceof Node) {
      if (popoverEl.contains(e.target)) return;
      if (popoverAnchorBtn && popoverAnchorBtn.contains(e.target)) return;
    }
    closePopover();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closePopover();
    }
  });

  window.addEventListener(
    'scroll',
    (e) => {
      if (!popoverEl || !popoverEl.classList.contains('is-open')) return;
      if (e.target instanceof Node && popoverEl.contains(e.target)) return;
      if (popoverAnchorBtn && popoverAnchorBtn.isConnected) {
        const currentTop = popoverAnchorBtn.getBoundingClientRect().top;
        if (Math.abs(currentTop - popoverAnchorTop) <= 10) return;
      }
      closePopover();
    },
    { passive: true, capture: true }
  );

  function createDownloadButton(article, initialCount) {
    const wrap = document.createElement('div');
    wrap.className = BTN_WRAP_CLASS;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = BTN_CLASS;
    btn.dataset.mediaCount = String(initialCount);
    btn.title = buildIdleTooltip(initialCount);
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

    btn.addEventListener('mouseenter', () => {
      if (btn.dataset.state === 'loading') return;
      if (userSettings.clickMode !== 'instant_hover') return;
      if (popoverAnchorBtn === btn && popoverEl?.classList.contains('is-open')) {
        if (closeTimer) {
          clearTimeout(closeTimer);
          closeTimer = null;
        }
        return;
      }
      clearPopoverTimers();
      openTimer = setTimeout(() => {
        openPopover(article, btn, false);
      }, 150);
    });

    btn.addEventListener('mouseleave', () => {
      if (openTimer) {
        clearTimeout(openTimer);
        openTimer = null;
      }
      if (!popoverPinned && popoverAnchorBtn === btn) {
        scheduleClosePopover(220);
      }
    });

    const handleContextMenu = (e) => {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      if (btn.dataset.state === 'loading') return;
      openPopover(article, btn, true);
    };

    btn.addEventListener('contextmenu', handleContextMenu, { capture: true });
    wrap.addEventListener('contextmenu', handleContextMenu, { capture: true });

    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (btn.dataset.state === 'loading') return;

      if (userSettings.clickMode === 'always_menu' && userSettings.presets.length > 1) {
        if (popoverAnchorBtn === btn && popoverEl?.classList.contains('is-open')) {
          closePopover();
        } else {
          openPopover(article, btn, true);
        }
        return;
      }

      closePopover();
      triggerDownload(article, btn, getActivePreset());
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
        btn.dataset.mediaCount = String(totalCount);
        const countEl = btn.querySelector('.x-img-dl-count');
        if (countEl) {
          countEl.textContent = totalCount > 1 ? String(totalCount) : '';
        }
        btn.title = buildIdleTooltip(totalCount);
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

  loadInitialSettings();
  scanAllTweets();
  observer.observe(document.body, { childList: true, subtree: true });
  setInterval(() => scanAllTweets(), 1500);
})();
