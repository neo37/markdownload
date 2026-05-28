// log some info
browser.runtime.getPlatformInfo().then(async platformInfo => {
  const browserInfo = browser.runtime.getBrowserInfo ? await browser.runtime.getBrowserInfo() : "Can't get browser info"
  console.info(platformInfo, browserInfo);
});

// Persistent debug log (ring buffer, max 200 lines) written to chrome.storage.local
async function dbgLog(...args) {
  const line = `[${new Date().toISOString()}] ` + args.map(a => {
    try { return (typeof a === 'object') ? JSON.stringify(a) : String(a); } catch { return String(a); }
  }).join(' ');
  console.log('[DBG]', line);
  try {
    const { _debugLog = [] } = await chrome.storage.local.get('_debugLog');
    _debugLog.push(line);
    if (_debugLog.length > 200) _debugLog.splice(0, _debugLog.length - 200);
    await chrome.storage.local.set({ _debugLog });
  } catch(e) { /* storage full or unavailable */ }
}

// add notification listener for foreground page messages
browser.runtime.onMessage.addListener(notify);
// create context menus
createMenus()

TurndownService.prototype.defaultEscape = TurndownService.prototype.escape;

// function to convert the article content to markdown using Turndown
function turndown(content, options, article) {

  if (options.turndownEscape) TurndownService.prototype.escape = TurndownService.prototype.defaultEscape;
  else TurndownService.prototype.escape = s => s;

  var turndownService = new TurndownService(options);

  turndownService.use(turndownPluginGfm.gfm)

  turndownService.keep(['iframe', 'sub', 'sup', 'u', 'ins', 'del', 'small', 'big']);

  let imageList = {};
  // add an image rule
  turndownService.addRule('images', {
    filter: function (node, tdopts) {
      // if we're looking at an img node with a src
      if (node.nodeName == 'IMG' && node.getAttribute('src')) {
        
        // get the original src
        let src = node.getAttribute('src')
        // set the new src
        node.setAttribute('src', validateUri(src, article.baseURI));
        
        // if we're downloading images, there's more to do.
        if (options.downloadImages) {
          // generate a file name for the image
          let imageFilename = getImageFilename(src, options, false);
          if (!imageList[src] || imageList[src] != imageFilename) {
            // if the imageList already contains this file, add a number to differentiate
            let i = 1;
            while (Object.values(imageList).includes(imageFilename)) {
              const parts = imageFilename.split('.');
              if (i == 1) parts.splice(parts.length - 1, 0, i++);
              else parts.splice(parts.length - 2, 1, i++);
              imageFilename = parts.join('.');
            }
            // add it to the list of images to download later
            imageList[src] = imageFilename;
          }
          // check if we're doing an obsidian style link
          const obsidianLink = options.imageStyle.startsWith("obsidian");
          // figure out the (local) src of the image
          const localSrc = options.imageStyle === 'obsidian-nofolder'
            // if using "nofolder" then we just need the filename, no folder
            ? imageFilename.substring(imageFilename.lastIndexOf('/') + 1)
            // otherwise we may need to modify the filename to uri encode parts for a pure markdown link
            : imageFilename.split('/').map(s => obsidianLink ? s : encodeURI(s)).join('/')
          
          // set the new src attribute to be the local filename
          if(options.imageStyle != 'originalSource' && options.imageStyle != 'base64') node.setAttribute('src', localSrc);
          // pass the filter if we're making an obsidian link (or stripping links)
          return true;
        }
        else return true
      }
      // don't pass the filter, just output a normal markdown link
      return false;
    },
    replacement: function (content, node, tdopts) {
      // if we're stripping images, output nothing
      if (options.imageStyle == 'noImage') return '';
      // if this is an obsidian link, so output that
      else if (options.imageStyle.startsWith('obsidian')) return `![[${node.getAttribute('src')}]]`;
      // otherwise, output the normal markdown link
      else {
        var alt = cleanAttribute(node.getAttribute('alt'));
        var src = node.getAttribute('src') || '';
        var title = cleanAttribute(node.getAttribute('title'));
        var titlePart = title ? ' "' + title + '"' : '';
        if (options.imageRefStyle == 'referenced') {
          var id = this.references.length + 1;
          this.references.push('[fig' + id + ']: ' + src + titlePart);
          return '![' + alt + '][fig' + id + ']';
        }
        else return src ? '![' + alt + ']' + '(' + src + titlePart + ')' : ''
      }
    },
    references: [],
    append: function (options) {
      var references = '';
      if (this.references.length) {
        references = '\n\n' + this.references.join('\n') + '\n\n';
        this.references = []; // Reset references
      }
      return references
    }

  });

  // add a rule for links
  turndownService.addRule('links', {
    filter: (node, tdopts) => {
      // check that this is indeed a link
      if (node.nodeName == 'A' && node.getAttribute('href')) {
        // get the href
        const href = node.getAttribute('href');
        // set the new href
        node.setAttribute('href', validateUri(href, article.baseURI));
        // if we are to strip links, the filter needs to pass
        return options.linkStyle == 'stripLinks';
      }
      // we're not passing the filter, just do the normal thing.
      return false;
    },
    // if the filter passes, we're stripping links, so just return the content
    replacement: (content, node, tdopts) => content
  });

  // handle multiple lines math
  turndownService.addRule('mathjax', {
    filter(node, options) {
      return article.math.hasOwnProperty(node.id);
    },
    replacement(content, node, options) {
      const math = article.math[node.id];
      let tex = math.tex.trim().replaceAll('\xa0', '');

      if (math.inline) {
        tex = tex.replaceAll('\n', ' ');
        return `$${tex}$`;
      }
      else
        return `$$\n${tex}\n$$`;
    }
  });

  function repeat(character, count) {
    return Array(count + 1).join(character);
  }

  function convertToFencedCodeBlock(node, options) {
    node.innerHTML = node.innerHTML.replaceAll('<br-keep></br-keep>', '<br>');
    const langMatch = node.id?.match(/code-lang-(.+)/);
    const language = langMatch?.length > 0 ? langMatch[1] : '';

    const code = node.innerText;

    const fenceChar = options.fence.charAt(0);
    let fenceSize = 3;
    const fenceInCodeRegex = new RegExp('^' + fenceChar + '{3,}', 'gm');

    let match;
    while ((match = fenceInCodeRegex.exec(code))) {
      if (match[0].length >= fenceSize) {
        fenceSize = match[0].length + 1;
      }
    }

    const fence = repeat(fenceChar, fenceSize);

    return (
      '\n\n' + fence + language + '\n' +
      code.replace(/\n$/, '') +
      '\n' + fence + '\n\n'
    )
  }

  turndownService.addRule('fencedCodeBlock', {
    filter: function (node, options) {
      return (
        options.codeBlockStyle === 'fenced' &&
        node.nodeName === 'PRE' &&
        node.firstChild &&
        node.firstChild.nodeName === 'CODE'
      );
    },
    replacement: function (content, node, options) {
      return convertToFencedCodeBlock(node.firstChild, options);
    }
  });

  // handle <pre> as code blocks
  turndownService.addRule('pre', {
    filter: (node, tdopts) => {
      return node.nodeName == 'PRE'
             && (!node.firstChild || node.firstChild.nodeName != 'CODE')
             && !node.querySelector('img');
    },
    replacement: (content, node, tdopts) => {
      return convertToFencedCodeBlock(node, tdopts);
    }
  });

  let markdown = options.frontmatter + turndownService.turndown(content)
      + options.backmatter;

  // strip out non-printing special characters which CodeMirror displays as a red dot
  // see: https://codemirror.net/doc/manual.html#option_specialChars
  markdown = markdown.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u00ad\u061c\u200b-\u200f\u2028\u2029\ufeff\ufff9-\ufffc]/g, '');
  
  return { markdown: markdown, imageList: imageList };
}

function cleanAttribute(attribute) {
  return attribute ? attribute.replace(/(\n+\s*)+/g, '\n') : ''
}

function validateUri(href, baseURI) {
  // check if the href is a valid url
  try {
    new URL(href);
  }
  catch {
    // if it's not a valid url, that likely means we have to prepend the base uri
    const baseUri = new URL(baseURI);

    // if the href starts with '/', we need to go from the origin
    if (href.startsWith('/')) {
      href = baseUri.origin + href
    }
    // otherwise we need to go from the local folder
    else {
      href = baseUri.href + (baseUri.href.endsWith('/') ? '/' : '') + href
    }
  }
  return href;
}

function getImageFilename(src, options, prependFilePath = true) {
  const slashPos = src.lastIndexOf('/');
  const queryPos = src.indexOf('?');
  let filename = src.substring(slashPos + 1, queryPos > 0 ? queryPos : src.length);

  let imagePrefix = (options.imagePrefix || '');

  if (prependFilePath && options.title.includes('/')) {
    imagePrefix = options.title.substring(0, options.title.lastIndexOf('/') + 1) + imagePrefix;
  }
  else if (prependFilePath) {
    imagePrefix = options.title + (imagePrefix.startsWith('/') ? '' : '/') + imagePrefix
  }
  
  if (filename.includes(';base64,')) {
    // this is a base64 encoded image, so what are we going to do for a filename here?
    filename = 'image.' + filename.substring(0, filename.indexOf(';'));
  }
  
  let extension = filename.substring(filename.lastIndexOf('.'));
  if (extension == filename) {
    // there is no extension, so we need to figure one out
    // for now, give it an 'idunno' extension and we'll process it later
    filename = filename + '.idunno';
  }

  filename = generateValidFileName(filename, options.disallowedChars);

  return imagePrefix + filename;
}

// function to replace placeholder strings with article info
function textReplace(string, article, disallowedChars = null) {
  if (!article) return string.replace(/{[^}]*}/g, '');
  for (const key in article) {
    if (article.hasOwnProperty(key) && key != "content") {
      let s = (article[key] || '') + '';
      if (s && disallowedChars) s = this.generateValidFileName(s, disallowedChars);

      string = string.replace(new RegExp('{' + key + '}', 'g'), s)
        .replace(new RegExp('{' + key + ':lower}', 'g'), s.toLowerCase())
        .replace(new RegExp('{' + key + ':upper}', 'g'), s.toUpperCase())
        .replace(new RegExp('{' + key + ':kebab}', 'g'), s.replace(/ /g, '-').toLowerCase())
        .replace(new RegExp('{' + key + ':mixed-kebab}', 'g'), s.replace(/ /g, '-'))
        .replace(new RegExp('{' + key + ':snake}', 'g'), s.replace(/ /g, '_').toLowerCase())
        .replace(new RegExp('{' + key + ':mixed_snake}', 'g'), s.replace(/ /g, '_'))
        // For Obsidian Custom Attachment Location plugin, we need to replace spaces with hyphens, but also remove any double hyphens.
        .replace(new RegExp('{' + key + ':obsidian-cal}', 'g'), s.replace(/ /g, '-').replace(/-{2,}/g, "-"))
        .replace(new RegExp('{' + key + ':camel}', 'g'), s.replace(/ ./g, (str) => str.trim().toUpperCase()).replace(/^./, (str) => str.toLowerCase()))
        .replace(new RegExp('{' + key + ':pascal}', 'g'), s.replace(/ ./g, (str) => str.trim().toUpperCase()).replace(/^./, (str) => str.toUpperCase()))
    }
  }

  // replace date formats
  const now = new Date();
  const dateRegex = /{date:(.+?)}/g
  const matches = string.match(dateRegex);
  if (matches && matches.forEach) {
    matches.forEach(match => {
      const format = match.substring(6, match.length - 1);
      const dateString = moment(now).format(format);
      string = string.replaceAll(match, dateString);
    });
  }

  // replace keywords
  const keywordRegex = /{keywords:?(.*)?}/g
  const keywordMatches = string.match(keywordRegex);
  if (keywordMatches && keywordMatches.forEach) {
    keywordMatches.forEach(match => {
      let seperator = match.substring(10, match.length - 1)
      try {
        seperator = JSON.parse(JSON.stringify(seperator).replace(/\\\\/g, '\\'));
      }
      catch { }
      const keywordsString = (article.keywords || []).join(seperator);
      string = string.replace(new RegExp(match.replace(/\\/g, '\\\\'), 'g'), keywordsString);
    })
  }

  // replace anything left in curly braces
  const defaultRegex = /{(.*?)}/g
  string = string.replace(defaultRegex, '')

  return string;
}

// function to convert an article info object into markdown
async function convertArticleToMarkdown(article, downloadImages = null, tabId = null) {
  const options = await getOptions();
  if (downloadImages != null) {
    options.downloadImages = downloadImages;
  }

  // substitute front and backmatter templates (uses moment — must run in SW)
  if (options.includeTemplate) {
    options.frontmatter = textReplace(options.frontmatter, article) + '\n';
    options.backmatter = '\n' + textReplace(options.backmatter, article);
  }
  else {
    options.frontmatter = options.backmatter = '';
  }

  options.imagePrefix = textReplace(options.imagePrefix, article, options.disallowedChars)
    .split('/').map(s=>generateValidFileName(s, options.disallowedChars)).join('/');

  let result;

  if (tabId) {
    // Run Turndown inside the tab where document/DOMParser are always available
    try {
      dbgLog('convertArticleToMarkdown: injecting into tabId', tabId);
      await chrome.scripting.executeScript({ target: { tabId }, files: ['/background/turndown.js'] });
      await chrome.scripting.executeScript({ target: { tabId }, files: ['/background/turndown-plugin-gfm.js'] });
      await chrome.scripting.executeScript({ target: { tabId }, files: ['/background/convert-article.js'] });
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: (content, opts, art) => turndownInPage(content, opts, art),
        args: [article.content, options, article]
      });
      result = results?.[0]?.result;
      dbgLog('convertArticleToMarkdown: tab conversion ok, markdown length', result?.markdown?.length);
    } catch (e) {
      dbgLog('convertArticleToMarkdown: tab conversion FAILED', e.message);
      console.error('Tab-based conversion failed, falling back to SW:', e);
    }
  }

  if (!result) {
    dbgLog('convertArticleToMarkdown: falling back to SW turndown');
    result = turndown(article.content, options, article);
  }

  if (options.downloadImages && options.downloadMode == 'downloadsApi') {
    // pre-download the images
    result = await preDownloadImages(result.imageList, result.markdown);
  }
  return result;
}

// function to turn the title into a valid file name
function generateValidFileName(title, disallowedChars = null) {
  if (!title) return title;
  else title = title + '';
  // remove < > : " / \ | ? * 
  var illegalRe = /[\/\?<>\\:\*\|":]/g;
  // and non-breaking spaces (thanks @Licat)
  var name = title.replace(illegalRe, "").replace(new RegExp('\u00A0', 'g'), ' ')
      // collapse extra whitespace
      .replace(new RegExp(/\s+/, 'g'), ' ')
      // remove leading/trailing whitespace that can cause issues when using {pageTitle} in a download path
      .trim();

  if (disallowedChars) {
    for (let c of disallowedChars) {
      if (`[\\^$.|?*+()`.includes(c)) c = `\\${c}`;
      name = name.replace(new RegExp(c, 'g'), '');
    }
  }
  
  return name;
}

async function preDownloadImages(imageList, markdown) {
  const options = await getOptions();
  let newImageList = {};
  // originally, I was downloading the markdown file first, then all the images
  // however, in some cases we need to download images *first* so we can get the
  // proper file extension to put into the markdown.
  // so... here we are waiting for all the downloads and replacements to complete
  await Promise.all(Object.entries(imageList).map(async ([src, filename]) => {
    try {
      const response = await fetch(src);
      const blob = await response.blob();

      if (options.imageStyle == 'base64') {
        const dataUrl = await blobToDataUrl(blob);
        markdown = markdown.replaceAll(src, dataUrl);
      } else {
        let newFilename = filename;
        if (newFilename.endsWith('.idunno')) {
          newFilename = filename.replace('.idunno', '.' + mimedb[blob.type]);
          if (!options.imageStyle.startsWith("obsidian")) {
            markdown = markdown.replaceAll(filename.split('/').map(s => encodeURI(s)).join('/'), newFilename.split('/').map(s => encodeURI(s)).join('/'));
          } else {
            markdown = markdown.replaceAll(filename, newFilename);
          }
        }
        const dataUrl = await blobToDataUrl(blob);
        newImageList[dataUrl] = newFilename;
      }
    } catch(e) {
      console.warn('Failed to download image', src, e);
    }
  }));

  return { imageList: newImageList, markdown: markdown };
}

// function to actually download the markdown file
async function downloadMarkdown(markdown, title, tabId, imageList = {}, mdClipsFolder = '') {
  const options = await getOptions();

  if (options.downloadMode == 'downloadsApi' && browser.downloads) {
    const url = `data:text/plain;charset=utf-8,${encodeURIComponent(markdown)}`;
    try {
      if (mdClipsFolder && !mdClipsFolder.endsWith('/')) mdClipsFolder += '/';
      const safeTitle = generateValidFileName(title, options.disallowedChars) || 'untitled';
      const id = await browser.downloads.download({
        url: url,
        filename: mdClipsFolder + safeTitle + ".txt",
        saveAs: false,
        conflictAction: 'uniquify'
      });

      // add a listener for the download completion
      browser.downloads.onChanged.addListener(downloadListener(id, url));

      // download images directly (imageList may contain data: URLs — too large for storage queue)
      if (options.downloadImages) {
        let destPath = mdClipsFolder + title.substring(0, title.lastIndexOf('/'));
        if (destPath && !destPath.endsWith('/')) destPath += '/';
        for (const [src, filename] of Object.entries(imageList || {})) {
          try {
            const imgId = await browser.downloads.download({
              url: src,
              filename: destPath ? destPath + filename : filename,
              saveAs: false,
              conflictAction: 'uniquify'
            });
            browser.downloads.onChanged.addListener(downloadListener(imgId, src));
          } catch(e) {
            console.warn('[downloadMarkdown] image failed', filename, e);
          }
        }
      }
    }
    catch (err) {
      console.error("Download failed", err);
    }
  }
  // // download via obsidian://new uri
  // else if (options.downloadMode == 'obsidianUri') {
  //   try {
  //     await ensureScripts(tabId);
  //     let uri = 'obsidian://new?';
  //     uri += `${options.obsidianPathType}=${encodeURIComponent(title)}`;
  //     if (options.obsidianVault) uri += `&vault=${encodeURIComponent(options.obsidianVault)}`;
  //     uri += `&content=${encodeURIComponent(markdown)}`;
  //     let code = `window.location='${uri}'`;
  //     await browser.tabs.executeScript(tabId, {code: code});
  //   }
  //   catch (error) {
  //     // This could happen if the extension is not allowed to run code in
  //     // the page, for example if the tab is a privileged page.
  //     console.error("Failed to execute script: " + error);
  //   };
    
  // }
  // download via content link
  else {
    try {
      await ensureScripts(tabId);
      const filename = mdClipsFolder + generateValidFileName(title, options.disallowedChars) + ".md";
      const code = `downloadMarkdown("${filename}","${base64EncodeUnicode(markdown)}");`
      await chrome.scripting.executeScript({target: {tabId}, func: (c) => eval(c), args: [code]});
    }
    catch (error) {
      // This could happen if the extension is not allowed to run code in
      // the page, for example if the tab is a privileged page.
      console.error("Failed to execute script: " + error);
    };
  }
}

async function downloadImgItem(item) {
  try {
    const id = await browser.downloads.download({
      url: item.src, filename: item.filename, saveAs: false, conflictAction: 'uniquify'
    });
    await new Promise(resolve => {
      const listener = (delta) => {
        if (delta.id === id && delta.state &&
            (delta.state.current === 'complete' || delta.state.current === 'interrupted')) {
          browser.downloads.onChanged.removeListener(listener);
          resolve();
        }
      };
      browser.downloads.onChanged.addListener(listener);
    });
  } catch(e) {
    console.warn('[imgQueue] failed', item.filename, e);
  }
}

// Drain the entire queue right now (used when tab is about to close)
async function processImgQueueNow() {
  const { _imgQueue = [] } = await chrome.storage.local.get('_imgQueue');
  if (!_imgQueue.length) return;
  await chrome.storage.local.set({ _imgQueue: [] });
  for (const item of _imgQueue) {
    await downloadImgItem(item);
  }
}

async function processImgQueue() {
  const { _imgQueueRunning } = await chrome.storage.local.get('_imgQueueRunning');
  if (_imgQueueRunning) return;
  await chrome.storage.local.set({ _imgQueueRunning: true });
  try {
    while (true) {
      const { _imgQueue = [] } = await chrome.storage.local.get('_imgQueue');
      if (!_imgQueue.length) break;
      const [item, ...rest] = _imgQueue;
      await chrome.storage.local.set({ _imgQueue: rest });
      await downloadImgItem(item);
    }
  } finally {
    await chrome.storage.local.set({ _imgQueueRunning: false });
  }
}

function downloadListener(id, url) {
  const self = (delta) => {
    if (delta.id === id && delta.state && delta.state.current == "complete") {
      // detatch this listener
      browser.downloads.onChanged.removeListener(self);
      // data URLs don't need revocation
    }
  }
  return self;
}

function base64EncodeUnicode(str) {
  // Firstly, escape the string using encodeURIComponent to get the UTF-8 encoding of the characters, 
  // Secondly, we convert the percent encodings into raw bytes, and add it to btoa() function.
  const utf8Bytes = encodeURIComponent(str).replace(/%([0-9A-F]{2})/g, function (match, p1) {
    return String.fromCharCode('0x' + p1);
  });

  return btoa(utf8Bytes);
}

//function that handles messages from the injected script into the site
async function notify(message, sender) {
  const options = await this.getOptions();
  // message for initial clipping of the dom
  if (message.type == "clip") {
    // Use the tab context to parse with Readability (DOMParser not available in MV3 SW)
    const tabId = sender && sender.tab && sender.tab.id;
    let article;
    if (tabId) {
      article = await getArticleFromContent(tabId, !!(message.selection && message.clipSelection));
    } else {
      // fallback: try to get the active tab
      const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (activeTab) {
        article = await getArticleFromContent(activeTab.id, !!(message.selection && message.clipSelection));
      }
    }

    if (!article) return;

    // convert the article to markdown
    const { markdown, imageList } = await convertArticleToMarkdown(article, null, tabId || (await chrome.tabs.query({active:true,currentWindow:true}))[0]?.id);

    // format the title
    article.title = await formatTitle(article);

    // format the mdClipsFolder
    const mdClipsFolder = await formatMdClipsFolder(article);

    // display the data in the popup
    await browser.runtime.sendMessage({ type: "display.md", markdown: markdown, article: article, imageList: imageList, mdClipsFolder: mdClipsFolder});
  }
  // message for triggering download
  else if (message.type == "download") {
    downloadMarkdown(message.markdown, message.title, message.tab.id, message.imageList, message.mdClipsFolder);
  }
  // ── Page Saver handlers ──────────────────────────────────────────────────
  else if (message.type === 'ps-crawl-domain') {
    psCrawlDomain(message.tabId, message.url);
  }
  else if (message.type === 'ps-stop-crawl') {
    _crawlState.running = false;
  }
  else if (message.type === 'ps-open-links') {
    psOpenLinks(message.tabId);
  }
  else if (message.type === 'ps-save-html') {
    psSaveTabs(message.tabs, 'html');
  }
  else if (message.type === 'ps-save-png') {
    psSaveTabs(message.tabs, 'png');
  }
  else if (message.type === 'ps-save-pdf') {
    psSaveTabs(message.tabs, 'pdf', message.pdfMode);
  }
  else if (message.type === 'ps-save-md-all') {
    const mdTabs = (message.tabs || []).filter(t =>
      t.url && !t.url.startsWith('chrome://') && !t.url.startsWith('chrome-extension://') && !t.url.startsWith('about:')
    );
    dbgLog('ps-save-md-all: processing', mdTabs.length, 'tabs');
    // Sequential — await each tab so SW stays alive and errors don't cascade
    ;(async () => {
      for (const tab of mdTabs) {
        try {
          dbgLog('ps-save-md-all: saving tab', tab.id, tab.title);
          await downloadMarkdownFromContext({ menuItemId: 'download-markdown-all' }, tab);
          dbgLog('ps-save-md-all: done', tab.id);
        } catch (e) {
          dbgLog('ps-save-md-all: FAILED tab', tab.id, e.message);
          console.error(`[md-all] failed for "${tab.title}":`, e);
        }
      }
      dbgLog('ps-save-md-all: all done');
    })();
  }
  else if (message.type === 'block-picked') {
    // relay selector from content script → popup
    browser.runtime.sendMessage({ type: 'block-picked', selector: message.selector }).catch(() => {});
  }
  else if (message.type === 'block-pick-cancelled') {
    browser.runtime.sendMessage({ type: 'block-pick-cancelled' }).catch(() => {});
  }
  else if (message.type === 'ps-save-block-all') {
    psSaveBlockAll(message.tabs, message.selector, message.saveAs);
  }
  else if (message.type === 'ps-img-queue-start') {
    processImgQueue();
  }
  else if (message.type === 'ps-open-url-list') {
    psOpenUrlList(message.urls, message.delay, message.mode, message.closeTabs !== false);
  }
  else if (message.type === 'ps-queue-images') {
    psQueueImages(message.tabs);
  }
}

browser.commands.onCommand.addListener(function (command) {
  const tab = browser.tabs.getCurrent()
  if (command == "download_tab_as_markdown") {
    const info = { menuItemId: "download-markdown-all" };
    downloadMarkdownFromContext(info, tab);
  }
  else if (command == "copy_tab_as_markdown") {
    const info = { menuItemId: "copy-markdown-all" };
    copyMarkdownFromContext(info, tab);
  }
  else if (command == "copy_selection_as_markdown") {
    const info = { menuItemId: "copy-markdown-selection" };
    copyMarkdownFromContext(info, tab);
  }
  else if (command == "copy_tab_as_markdown_link") {
    copyTabAsMarkdownLink(tab);
  }
  else if (command == "copy_selected_tab_as_markdown_link") {
    copySelectedTabAsMarkdownLink(tab);
  }
  else if (command == "copy_selection_to_obsidian") {
    const info = { menuItemId: "copy-markdown-obsidian" };
    copyMarkdownFromContext(info, tab);
  }
  else if (command == "copy_tab_to_obsidian") {
    const info = { menuItemId: "copy-markdown-obsall" };
    copyMarkdownFromContext(info, tab);
  }
});

// click handler for the context menus
browser.contextMenus.onClicked.addListener(function (info, tab) {
  // one of the copy to clipboard commands
  if (info.menuItemId.startsWith("copy-markdown")) {
    copyMarkdownFromContext(info, tab);
  }
  else if (info.menuItemId == "download-markdown-alltabs" || info.menuItemId == "tab-download-markdown-alltabs") {
    downloadMarkdownForAllTabs(info);
  }
  // one of the download commands
  else if (info.menuItemId.startsWith("download-markdown")) {
    downloadMarkdownFromContext(info, tab);
  }
  // copy tab as markdown link
  else if (info.menuItemId.startsWith("copy-tab-as-markdown-link-all")) {
    copyTabAsMarkdownLinkAll(tab);
  }
  // copy only selected tab as markdown link
  else if (info.menuItemId.startsWith("copy-tab-as-markdown-link-selected")) {
    copySelectedTabAsMarkdownLink(tab);
  }
  else if (info.menuItemId.startsWith("copy-tab-as-markdown-link")) {
    copyTabAsMarkdownLink(tab);
  }
  // a settings toggle command
  else if (info.menuItemId.startsWith("toggle-") || info.menuItemId.startsWith("tabtoggle-")) {
    toggleSetting(info.menuItemId.split('-')[1]);
  }
});

// this function toggles the specified option
async function toggleSetting(setting, options = null) {
  // if there's no options object passed in, we need to go get one
  if (options == null) {
      // get the options from storage and toggle the setting
      await toggleSetting(setting, await getOptions());
  }
  else {
    // toggle the option and save back to storage
    options[setting] = !options[setting];
    await browser.storage.sync.set(options);
    if (setting == "includeTemplate") {
      browser.contextMenus.update("toggle-includeTemplate", {
        checked: options.includeTemplate
      });
      try {
        browser.contextMenus.update("tabtoggle-includeTemplate", {
          checked: options.includeTemplate
        });
      } catch { }
    }
    
    if (setting == "downloadImages") {
      browser.contextMenus.update("toggle-downloadImages", {
        checked: options.downloadImages
      });
      try {
        browser.contextMenus.update("tabtoggle-downloadImages", {
          checked: options.downloadImages
        });
      } catch { }
    }
  }
}

// this function ensures the content script is loaded (and loads it if it isn't)
async function ensureScripts(tabId) {
  const results = await chrome.scripting.executeScript({target: {tabId}, func: () => typeof getSelectionAndDom === 'function'})
  // The content script's last expression will be true if the function
  // has been defined. If this is not the case, then we need to run
  // pageScraper.js to define function getSelectionAndDom.
  if (!results || results[0].result !== true) {
    await chrome.scripting.executeScript({target: {tabId}, files: ["/contentScript/contentScript.js"]});
  }
}

// get Readability article info from the dom passed in
async function getArticleFromDom(domString) {
  // parse the dom
  const parser = new DOMParser();
  const dom = parser.parseFromString(domString, "text/html");

  if (dom.documentElement.nodeName == "parsererror") {
    console.error("error while parsing");
  }

  const math = {};

  const storeMathInfo = (el, mathInfo) => {
    const randomId = crypto.randomUUID();
    el.id = randomId;
    math[randomId] = mathInfo;
  };

  dom.body.querySelectorAll('script[id^=MathJax-Element-]')?.forEach(mathSource => {
    const type = mathSource.attributes.type.value
    storeMathInfo(mathSource, {
      tex: mathSource.innerText,
      inline: type ? !type.includes('mode=display') : false
    });
  });

  dom.body.querySelectorAll('[markdownload-latex]')?.forEach(mathJax3Node =>  {
    const tex = mathJax3Node.getAttribute('markdownload-latex')
    const display = mathJax3Node.getAttribute('display')
    const inline = !(display && display === 'true')

    const mathNode = dom.createElement(inline ? "i" : "p")
    mathNode.textContent = tex;
    mathJax3Node.parentNode.insertBefore(mathNode, mathJax3Node.nextSibling)
    mathJax3Node.parentNode.removeChild(mathJax3Node)

    storeMathInfo(mathNode, {
      tex: tex,
      inline: inline
    });
  });

  dom.body.querySelectorAll('.katex-mathml')?.forEach(kaTeXNode => {
    storeMathInfo(kaTeXNode, {
      tex: kaTeXNode.querySelector('annotation').textContent,
      inline: true
    });
  });

  dom.body.querySelectorAll('[class*=highlight-text],[class*=highlight-source]')?.forEach(codeSource => {
    const language = codeSource.className.match(/highlight-(?:text|source)-([a-z0-9]+)/)?.[1]
    if (codeSource.firstChild.nodeName == "PRE") {
      codeSource.firstChild.id = `code-lang-${language}`
    }
  });

  dom.body.querySelectorAll('[class*=language-]')?.forEach(codeSource => {
    const language = codeSource.className.match(/language-([a-z0-9]+)/)?.[1]
    codeSource.id = `code-lang-${language}`;
  });

  dom.body.querySelectorAll('pre br')?.forEach(br => {
    // we need to keep <br> tags because they are removed by Readability.js
    br.outerHTML = '<br-keep></br-keep>';
  });

  dom.body.querySelectorAll('.codehilite > pre')?.forEach(codeSource => {
    if (codeSource.firstChild.nodeName !== 'CODE' && !codeSource.className.includes('language')) {
      codeSource.id = `code-lang-text`;
    }
  });

  dom.body.querySelectorAll('h1, h2, h3, h4, h5, h6')?.forEach(header => {
    // Readability.js will strip out headings from the dom if certain words appear in their className
    // See: https://github.com/mozilla/readability/issues/807  
    header.className = '';
    header.outerHTML = header.outerHTML;  
  });

  // Prevent Readability from removing the <html> element if has a 'class' attribute
  // which matches removal criteria.
  // Note: The document element is guaranteed to be the HTML tag because the 'text/html'
  // mime type was used when the DOM was created.
  dom.documentElement.removeAttribute('class')

  // simplify the dom into an article
  const article = new Readability(dom).parse();

  // get the base uri from the dom and attach it as important article info
  article.baseURI = dom.baseURI;
  // also grab the page title
  article.pageTitle = dom.title;
  // and some URL info
  const url = new URL(dom.baseURI);
  article.hash = url.hash;
  article.host = url.host;
  article.origin = url.origin;
  article.hostname = url.hostname;
  article.pathname = url.pathname;
  article.port = url.port;
  article.protocol = url.protocol;
  article.search = url.search;
  

  // make sure the dom has a head
  if (dom.head) {
    // and the keywords, should they exist, as an array
    article.keywords = dom.head.querySelector('meta[name="keywords"]')?.content?.split(',')?.map(s => s.trim());

    // add all meta tags, so users can do whatever they want
    dom.head.querySelectorAll('meta[name][content], meta[property][content]')?.forEach(meta => {
      const key = (meta.getAttribute('name') || meta.getAttribute('property'))
      const val = meta.getAttribute('content')
      if (key && val && !article[key]) {
        article[key] = val;
      }
    })
  }

  article.math = math

  // return the article
  return article;
}

// get Readability article info from the content of the tab id passed in
// `selection` is a bool indicating whether we should just get the selected text
async function getArticleFromContent(tabId, selection = false) {
  // inject dependencies into the tab (which has document/DOMParser)
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['/background/Readability.js'] });
    await chrome.scripting.executeScript({ target: { tabId }, files: ['/contentScript/get-article.js'] });
  } catch(e) {
    console.warn('Script injection warning:', e.message);
  }

  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: (sel) => {
      if (typeof getArticleFromCurrentPage !== 'function') return null;
      return getArticleFromCurrentPage(sel);
    },
    args: [selection]
  });

  return results?.[0]?.result || null;
}

// function to apply the title template
async function formatTitle(article) {
  let options = await getOptions();
  
  let title = textReplace(options.title, article, options.disallowedChars + '/');
  title = title.split('/').map(s=>generateValidFileName(s, options.disallowedChars)).join('/');
  return title;
}

async function formatMdClipsFolder(article) {
  let options = await getOptions();

  let mdClipsFolder = '';
  if (options.mdClipsFolder && options.downloadMode == 'downloadsApi') {
    mdClipsFolder = textReplace(options.mdClipsFolder, article, options.disallowedChars);
    mdClipsFolder = mdClipsFolder.split('/').map(s => generateValidFileName(s, options.disallowedChars)).join('/');
    if (!mdClipsFolder.endsWith('/')) mdClipsFolder += '/';
  }

  return mdClipsFolder;
}

async function formatObsidianFolder(article) {
  let options = await getOptions();

  let obsidianFolder = '';
  if (options.obsidianFolder) {
    obsidianFolder = textReplace(options.obsidianFolder, article, options.disallowedChars);
    obsidianFolder = obsidianFolder.split('/').map(s => generateValidFileName(s, options.disallowedChars)).join('/');
    if (!obsidianFolder.endsWith('/')) obsidianFolder += '/';
  }

  return obsidianFolder;
}

// function to download markdown, triggered by context menu
async function downloadMarkdownFromContext(info, tab) {
  await ensureScripts(tab.id);
  const article = await getArticleFromContent(tab.id, info.menuItemId == "download-markdown-selection");
  const title = await formatTitle(article);
  const { markdown, imageList } = await convertArticleToMarkdown(article, null, tab.id);
  const mdClipsFolder = await formatMdClipsFolder(article);
  await downloadMarkdown(markdown, title, tab.id, imageList, mdClipsFolder);
}

// function to copy a tab url as a markdown link
async function copyTabAsMarkdownLink(tab) {
  try {
    await ensureScripts(tab.id);
    const article = await getArticleFromContent(tab.id);
    const title = await formatTitle(article);
    await chrome.scripting.executeScript({target: {tabId: tab.id}, func: (text) => copyToClipboard(text), args: [`[${title}](${article.baseURI})`]});
    // await navigator.clipboard.writeText(`[${title}](${article.baseURI})`);
  }
  catch (error) {
    // This could happen if the extension is not allowed to run code in
    // the page, for example if the tab is a privileged page.
    console.error("Failed to copy as markdown link: " + error);
  };
}

// function to copy all tabs as markdown links
async function copyTabAsMarkdownLinkAll(tab) {
  try {
    const options = await getOptions();
    options.frontmatter = options.backmatter = '';
    const tabs = await browser.tabs.query({
      currentWindow: true
    });
    
    const links = [];
    for(const tab of tabs) {
      await ensureScripts(tab.id);
      const article = await getArticleFromContent(tab.id);
      const title = await formatTitle(article);
      const link = `${options.bulletListMarker} [${title}](${article.baseURI})`
      links.push(link)
    };
    
    const markdown = links.join(`\n`)
    await chrome.scripting.executeScript({target: {tabId: tab.id}, func: (text) => copyToClipboard(text), args: [markdown]});

  }
  catch (error) {
    // This could happen if the extension is not allowed to run code in
    // the page, for example if the tab is a privileged page.
    console.error("Failed to copy as markdown link: " + error);
  };
}

// function to copy only selected tabs as markdown links
async function copySelectedTabAsMarkdownLink(tab) {
  try {
    const options = await getOptions();
    options.frontmatter = options.backmatter = '';
    const tabs = await browser.tabs.query({
      currentWindow: true,
      highlighted: true
    });

    const links = [];
    for (const tab of tabs) {
      await ensureScripts(tab.id);
      const article = await getArticleFromContent(tab.id);
      const title = await formatTitle(article);
      const link = `${options.bulletListMarker} [${title}](${article.baseURI})`
      links.push(link)
    };

    const markdown = links.join(`\n`)
    await chrome.scripting.executeScript({target: {tabId: tab.id}, func: (text) => copyToClipboard(text), args: [markdown]});

  }
  catch (error) {
    // This could happen if the extension is not allowed to run code in
    // the page, for example if the tab is a privileged page.
    console.error("Failed to copy as markdown link: " + error);
  };
}

// function to copy markdown to the clipboard, triggered by context menu
async function copyMarkdownFromContext(info, tab) {
  try{
    await ensureScripts(tab.id);

    const platformOS = navigator.platform;
    var folderSeparator = "";
    if(platformOS.indexOf("Win") === 0){
      folderSeparator = "\\";
    }else{
      folderSeparator = "/";
    }

    if (info.menuItemId == "copy-markdown-link") {
      const options = await getOptions();
      options.frontmatter = options.backmatter = '';
      const article = await getArticleFromContent(tab.id, false);
      const { markdown } = turndown(`<a href="${info.linkUrl}">${info.linkText || info.selectionText}</a>`, { ...options, downloadImages: false }, article);
      await chrome.scripting.executeScript({target: {tabId: tab.id}, func: (text) => copyToClipboard(text), args: [markdown]});
    }
    else if (info.menuItemId == "copy-markdown-image") {
      await chrome.scripting.executeScript({target: {tabId: tab.id}, func: (url) => copyToClipboard(`![](${url})`), args: [info.srcUrl]});
    }
    else if(info.menuItemId == "copy-markdown-obsidian") {
      const article = await getArticleFromContent(tab.id, info.menuItemId == "copy-markdown-obsidian");
      const title = await formatTitle(article);
      const options = await getOptions();
      const obsidianVault = options.obsidianVault;
      const obsidianFolder = await formatObsidianFolder(article);
      const { markdown } = await convertArticleToMarkdown(article, false, tab.id);
      await chrome.scripting.executeScript({target: {tabId: tab.id}, func: (text) => copyToClipboard(text), args: [markdown]});
      await chrome.tabs.update({url: "obsidian://advanced-uri?vault=" + obsidianVault + "&clipboard=true&mode=new&filepath=" + obsidianFolder + generateValidFileName(title)});
    }
    else if(info.menuItemId == "copy-markdown-obsall") {
      const article = await getArticleFromContent(tab.id, info.menuItemId == "copy-markdown-obsall");
      const title = await formatTitle(article);
      const options = await getOptions();
      const obsidianVault = options.obsidianVault;
      const obsidianFolder = await formatObsidianFolder(article);
      const { markdown } = await convertArticleToMarkdown(article, false, tab.id);
      await chrome.scripting.executeScript({target: {tabId: tab.id}, func: (text) => copyToClipboard(text), args: [markdown]});
      await browser.tabs.update({url: "obsidian://advanced-uri?vault=" + obsidianVault + "&clipboard=true&mode=new&filepath=" + obsidianFolder + generateValidFileName(title)});
    }
    else {
      const article = await getArticleFromContent(tab.id, info.menuItemId == "copy-markdown-selection");
      const { markdown } = await convertArticleToMarkdown(article, false, tab.id);
      await chrome.scripting.executeScript({target: {tabId: tab.id}, func: (text) => copyToClipboard(text), args: [markdown]});
    }
  }
  catch (error) {
    // This could happen if the extension is not allowed to run code in
    // the page, for example if the tab is a privileged page.
    console.error("Failed to copy text: " + error);
  };
}

async function downloadMarkdownForAllTabs(info) {
  const tabs = await browser.tabs.query({
    currentWindow: true
  });
  tabs.forEach(tab => {
    downloadMarkdownFromContext(info, tab);
  });
}

/**
 * String.prototype.replaceAll() polyfill
 * https://gomakethings.com/how-to-replace-a-section-of-a-string-with-another-one-with-vanilla-js/
 * @author Chris Ferdinandi
 * @license MIT
 */
if (!String.prototype.replaceAll) {
	String.prototype.replaceAll = function(str, newStr){

		// If a regex pattern
		if (Object.prototype.toString.call(str).toLowerCase() === '[object regexp]') {
			return this.replace(str, newStr);
		}

		// If a string
		return this.replace(new RegExp(str, 'g'), newStr);

	};
}

// ════════════════════════════════════════════════════════════════════════════
// Page Saver — HTML / PNG / PDF / open-links
// ════════════════════════════════════════════════════════════════════════════

function psTimestamp() {
  // moment.js is loaded in background
  return moment().format('YYYY-MM-DD_HH-mm');
}

function psSanitize(name) {
  return (name || 'page').replace(/[\\/:*?"<>|]/g, '_').substring(0, 100);
}

async function psDownloadBlob(blob, filename) {
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunk = 8192;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  const url = `data:${blob.type};base64,${btoa(binary)}`;
  return browser.downloads.download({ url, filename, saveAs: false, conflictAction: 'uniquify' });
}

function psBase64ToBlob(b64, mime) {
  const bytes = atob(b64);
  const arr = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
  return new Blob([arr], { type: mime });
}


function swDelay(ms) {
  // Keeps the service worker alive during long waits by pinging storage
  return new Promise(resolve => {
    const start = Date.now();
    const tick = () => {
      const remaining = ms - (Date.now() - start);
      if (remaining <= 0) { resolve(); return; }
      chrome.storage.local.get('_ka', () => setTimeout(tick, Math.min(remaining, 20000)));
    };
    tick();
  });
}

async function psOpenUrlList(urls, delaySec = 3, mode = 'open', closeTabs = true) {
  if (mode === 'open') {
    for (let i = 0; i < urls.length; i++) {
      if (i > 0) await swDelay(delaySec * 1000);
      browser.tabs.create({ url: urls[i], active: false });
    }
    return;
  }

  const folder = psTimestamp();
  const [prevActive] = await browser.tabs.query({ active: true, currentWindow: true });
  const { _blockSelector } = await chrome.storage.local.get('_blockSelector');
  const sel = _blockSelector || null;

  for (let i = 0; i < urls.length; i++) {
    let tab;
    try {
      tab = await browser.tabs.create({ url: urls[i], active: true });
      await waitForTabLoad(tab.id);
      // user-configured delay after load — lets JS-heavy pages finish rendering
      await swDelay(delaySec * 1000);

      try {
        if (mode === 'markdown') {
          if (sel) {
            await psSaveBlockAll([tab], sel, false);
          } else {
            await downloadMarkdownFromContext({ menuItemId: 'download-markdown-all' }, tab);
          }
        } else if (mode === 'screenshot') {
          await psTabToPng(tab, folder, sel);
        } else if (mode === 'pdf') {
          await psTabToPdf(tab, folder, false);
        } else if (mode === 'pdf-print') {
          await psTabToPdf(tab, folder, true);
        }
      } catch(e) {
        console.error('[psOpenUrlList] action failed for', urls[i], e);
      }

      // for images-only mode: queue from DOM then drain before tab closes
      if (mode === 'images') {
        try {
          await psQueueImages([tab]);
        } catch(e) {
          console.warn('[psOpenUrlList] psQueueImages failed', e);
        }
        await processImgQueueNow();
      }

    } catch(e) {
      console.error('[psOpenUrlList] failed for', urls[i], e);
    } finally {
      if (tab && closeTabs) {
        browser.tabs.remove(tab.id).catch(() => {});
        if (prevActive) browser.tabs.update(prevActive.id, { active: true }).catch(() => {});
      }
    }

    await swDelay(500); // brief pause between URLs
  }
}

async function psOpenLinks(tabId) {
  const results = await chrome.scripting.executeScript({target: {tabId}, func: () => {
    const seen = new Set();
    const urls = [];
    document.querySelectorAll('a[href]').forEach(a => {
      try {
        const url = new URL(a.href, location.href).href;
        if (!seen.has(url) && !url.startsWith('javascript:') && !url.startsWith('mailto:')) {
          seen.add(url); urls.push(url);
        }
      } catch(e) {}
    });
    return urls;
  }});

  const urls = results[0].result || [];
  for (const url of urls) {
    await new Promise(r => setTimeout(r, 3000));
    browser.tabs.create({ url, active: false });
  }
}

// Save tab as HTML (rendered DOM)
async function psTabToHtml(tab, folder) {
  const results = await chrome.scripting.executeScript({target: {tabId: tab.id}, func: () => '<!DOCTYPE html>\n' + document.documentElement.outerHTML});
  const html = results[0].result;
  const title = psSanitize(tab.title);
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  return psDownloadBlob(blob, `page-saver/${folder}/html/${title}.html`);
}

// Save tab as scrolling PNG screenshots, optionally scoped to a CSS selector
function cdpCmd(tabId, method, params = {}) {
  return new Promise((res, rej) =>
    chrome.debugger.sendCommand({ tabId }, method, params,
      r => chrome.runtime.lastError ? rej(new Error(chrome.runtime.lastError.message)) : res(r))
  );
}

async function psTabToPng(tab, folder, blockSelector = null) {
  const title = psSanitize(tab.title);

  const tabInfo = await browser.tabs.get(tab.id);
  const windowId = tabInfo.windowId;
  await browser.tabs.update(tab.id, { active: true });
  await chrome.windows.update(windowId, { focused: true });
  await swDelay(600);

  // attach debugger for mouse/scroll simulation
  await new Promise((res, rej) =>
    chrome.debugger.attach({ tabId: tab.id }, '1.3', () =>
      chrome.runtime.lastError ? rej(new Error(chrome.runtime.lastError.message)) : res())
  );

  try {
    // get dimensions
    const [dimsResult] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (sel) => {
        if (sel) {
          const el = document.querySelector(sel);
          if (el) {
            const rect = el.getBoundingClientRect();
            const absTop = rect.top + window.scrollY;
            return { startY: absTop, scrollHeight: absTop + el.scrollHeight, innerHeight: window.innerHeight, innerWidth: window.innerWidth };
          }
        }
        return { startY: 0, scrollHeight: document.documentElement.scrollHeight, innerHeight: window.innerHeight, innerWidth: window.innerWidth };
      },
      args: [blockSelector || null]
    });
    const { startY, scrollHeight, innerHeight, innerWidth } = dimsResult?.result ?? { startY: 0, scrollHeight: 800, innerHeight: 800, innerWidth: 1280 };
    const cx = Math.floor(innerWidth / 2);
    const cy = Math.floor(innerHeight / 2);

    // scroll to start
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: (y) => window.scrollTo(0, y), args: [startY] });
    await swDelay(500);

    const shots = [];

    const getScrollY = async () => {
      const r = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => window.scrollY });
      return r?.[0]?.result ?? 0;
    };
    const getScrollHeight = async () => {
      const r = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => document.documentElement.scrollHeight });
      return r?.[0]?.result ?? innerHeight;
    };

    while (true) {
      const dataUrl = await browser.tabs.captureVisibleTab(windowId, { format: 'png' });
      shots.push(dataUrl.split(',')[1]);

      const curY = await getScrollY();
      const curScrollHeight = await getScrollHeight();

      dbgLog('[screenshot] scrollY=', curY, 'scrollHeight=', curScrollHeight, 'innerHeight=', innerHeight);

      if (curY + innerHeight >= curScrollHeight) break;

      // click center for focus, then scroll down one viewport
      await cdpCmd(tab.id, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: cx, y: cy, button: 'left', clickCount: 1 });
      await cdpCmd(tab.id, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: cx, y: cy, button: 'left', clickCount: 1 });
      await cdpCmd(tab.id, 'Input.synthesizeScrollGesture', { x: cx, y: cy, xDistance: 0, yDistance: innerHeight, speed: 800 });
      await swDelay(600);

      // verify scroll actually moved; if stuck, break
      const newY = await getScrollY();
      if (newY <= curY) break;
    }

    const base = blockSelector
      ? `page-saver/${folder}/screenshots/${title}-block`
      : `page-saver/${folder}/screenshots/${title}`;
    if (shots.length === 1) {
      await psDownloadBlob(psBase64ToBlob(shots[0], 'image/png'), base + '.png');
    } else {
      for (let i = 0; i < shots.length; i++) {
        await psDownloadBlob(psBase64ToBlob(shots[i], 'image/png'), `${base}/${String(i + 1).padStart(3, '0')}.png`);
      }
    }
  } finally {
    chrome.debugger.detach({ tabId: tab.id });
  }
}

// Save tab as PDF.
// single=true → opens browser print dialog (user picks filename, no black bg)
// single=false → CDP Page.printToPDF with printBackground:false → saves to downloads
async function psTabToPdf(tab, folder, single = false) {
  if (single) {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => window.print() });
    return;
  }
  const title = psSanitize(tab.title);

  await new Promise((res, rej) =>
    chrome.debugger.attach({ tabId: tab.id }, '1.3', () =>
      chrome.runtime.lastError ? rej(new Error(chrome.runtime.lastError.message)) : res()
    )
  );
  try {
    // check if page is already loaded
    const [readyResult] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => document.readyState
    }).catch(() => [{ result: 'loading' }]);
    const ready = readyResult?.result === 'complete';

    if (!ready) {
      // wait for load event via CDP
      await new Promise((res) => {
        const handler = (src, method) => {
          if (src.tabId === tab.id && method === 'Page.loadEventFired') {
            chrome.debugger.onEvent.removeListener(handler);
            res();
          }
        };
        chrome.debugger.onEvent.addListener(handler);
        chrome.debugger.sendCommand({ tabId: tab.id }, 'Page.enable', {}, () => {});
        // safety timeout
        swDelay(15000).then(res);
      });
    }

    // extra wait for JS-heavy SPAs to finish rendering
    await swDelay(5000);

    const result = await new Promise((res, rej) =>
      chrome.debugger.sendCommand(
        { tabId: tab.id },
        'Page.printToPDF',
        { printBackground: true, paperWidth: 8.27, paperHeight: 11.69,
          marginTop: 0.4, marginBottom: 0.4, marginLeft: 0.4, marginRight: 0.4 },
        r => chrome.runtime.lastError ? rej(new Error(chrome.runtime.lastError.message)) : res(r)
      )
    );
    return psDownloadBlob(psBase64ToBlob(result.data, 'application/pdf'), `page-saver/${folder}/pdf/${title}.pdf`);
  } finally {
    chrome.debugger.detach({ tabId: tab.id });
  }
}

// Batch runner — all tabs for a given format
async function psQueueImages(tabs) {
  const allowed = (tabs || []).filter(t =>
    t.url && !t.url.startsWith('chrome://') && !t.url.startsWith('chrome-extension://') && !t.url.startsWith('about:')
  );
  const folder = psTimestamp();
  const { _blockSelector } = await chrome.storage.local.get('_blockSelector');
  let total = 0;
  for (const tab of allowed) {
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: (sel) => {
          const root = sel ? document.querySelector(sel) : document;
          if (!root) return [];
          const seen = new Set();
          const srcs = [];
          root.querySelectorAll('img').forEach(img => {
            // regular src + lazy-load attributes
            const candidates = [
              img.src,
              img.getAttribute('data-src'),
              img.getAttribute('data-lazy'),
              img.getAttribute('data-lazy-src'),
              img.getAttribute('data-original'),
              img.getAttribute('data-url'),
            ];
            // srcset — take the highest resolution url
            const ss = img.getAttribute('srcset') || img.getAttribute('data-srcset');
            if (ss) {
              const last = ss.trim().split(',').pop().trim().split(/\s+/)[0];
              if (last) candidates.push(last);
            }
            for (const c of candidates) {
              if (c && (c.startsWith('http://') || c.startsWith('https://')) && !seen.has(c)) {
                seen.add(c);
                srcs.push(c);
              }
            }
          });
          return srcs;
        },
        args: [_blockSelector || null]
      });
      const srcs = results?.[0]?.result || [];
      const newItems = srcs.map((src, idx) => {
        const safeTab = psSanitize(tab.title);
        // derive filename from URL; add .jpg fallback if no extension
        let name = src.split('/').pop().split('?')[0].split('#')[0] || `img_${idx}`;
        if (!name.includes('.')) name += '.jpg';
        return { src, filename: `images/${folder}/${safeTab}/${name}` };
      });
      if (newItems.length) {
        const { _imgQueue = [] } = await chrome.storage.local.get('_imgQueue');
        await chrome.storage.local.set({ _imgQueue: [..._imgQueue, ...newItems] });
        total += newItems.length;
      }
    } catch(e) {
      console.warn('[psQueueImages] failed for', tab.title, e);
    }
  }
  dbgLog('psQueueImages: queued', total, 'images from', allowed.length, 'tabs', _blockSelector ? `(block: ${_blockSelector})` : '(whole page)');
}

async function psSaveTabs(tabs, format, pdfMode = 'cdp') {
  const folder = psTimestamp();
  const allowed = (tabs || []).filter(t =>
    t.url && !t.url.startsWith('chrome://') && !t.url.startsWith('chrome-extension://')
  );

  for (const tab of allowed) {
    try {
      if (format === 'html') await psTabToHtml(tab, folder);
      else if (format === 'png')  await psTabToPng(tab, folder);
      else if (format === 'pdf')  await psTabToPdf(tab, folder, pdfMode === 'print');
    } catch (e) {
      console.error(`[page-saver] ${format} failed for "${tab.title}":`, e.message || e);
    }
  }
}

// Save a specific CSS block from all tabs as Markdown + images
async function psSaveBlockAll(tabs, selector, saveAs = false) {
  const folder = `block-save/${psTimestamp()}`;
  const allowed = (tabs || []).filter(t =>
    t.url && !t.url.startsWith('chrome://') && !t.url.startsWith('chrome-extension://') && !t.url.startsWith('about:')
  );
  dbgLog('psSaveBlockAll: selector=', selector, 'tabs=', allowed.length, 'folder=', folder);

  for (const tab of allowed) {
    try {
      // 1. Get the block's outer HTML from the tab
      const extractResult = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: (sel) => {
          const el = document.querySelector(sel);
          if (!el) return null;
          return {
            content: el.outerHTML,
            title: document.title,
            baseURI: document.baseURI,
            pageTitle: document.title,
            byline: null, excerpt: null, siteName: null,
            keywords: [], math: {}
          };
        },
        args: [selector]
      });

      const article = extractResult?.[0]?.result;
      if (!article) {
        dbgLog('psSaveBlockAll: block not found on', tab.title);
        continue;
      }

      // 2. Convert block to Markdown (inject scripts + run in tab)
      const options = await getOptions();
      options.frontmatter = options.backmatter = '';
      options.downloadImages = true;
      options.imagePrefix = folder + '/images/';
      options.saveAs = false;

      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['/background/turndown.js'] });
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['/background/turndown-plugin-gfm.js'] });
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['/background/convert-article.js'] });

      const convResult = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: (content, opts, art) => turndownInPage(content, opts, art),
        args: [article.content, options, article]
      });

      const { markdown, imageList } = convResult?.[0]?.result || {};
      if (!markdown) { dbgLog('psSaveBlockAll: no markdown for', tab.title); continue; }

      // 3. Download images
      for (const [src, filename] of Object.entries(imageList || {})) {
        try {
          await browser.downloads.download({ url: src, filename, saveAs: false, conflictAction: 'uniquify' });
        } catch (e) { /* image might be CORS-blocked */ }
      }

      // 4. Save markdown file
      const safeTitle = generateValidFileName(article.title) || 'page';
      const mdUrl = `data:text/plain;charset=utf-8,${encodeURIComponent(markdown)}`;
      await browser.downloads.download({
        url: mdUrl,
        filename: `${folder}/${safeTitle}.txt`,
        saveAs: false,
        conflictAction: 'uniquify'
      });

      dbgLog('psSaveBlockAll: saved', safeTitle);
    } catch (e) {
      dbgLog('psSaveBlockAll: error on', tab.title, e.message);
      console.error('[block-save]', tab.title, e);
    }
  }
  dbgLog('psSaveBlockAll: done');
}

// Recursive same-domain crawler
const _crawlState = { running: false, visited: new Set(), queue: [] };

async function psCrawlDomain(startTabId, startUrl) {
  if (_crawlState.running) return; // prevent double-start
  _crawlState.running = true;
  _crawlState.visited = new Set();
  _crawlState.queue = [];

  const domain = new URL(startUrl).hostname;
  _crawlState.visited.add(normalizeUrl(startUrl));

  const firstLinks = await psGetSameDomainLinks(startTabId, domain, _crawlState.visited);
  _crawlState.queue.push(...firstLinks);

  while (_crawlState.running && _crawlState.queue.length > 0) {
    const url = _crawlState.queue.shift();
    const norm = normalizeUrl(url);
    if (_crawlState.visited.has(norm)) continue;
    _crawlState.visited.add(norm);

    // open tab and wait for it to load
    const tab = await chrome.tabs.create({ url, active: false });
    await waitForTabLoad(tab.id);
    await new Promise(r => setTimeout(r, 2000)); // let JS render

    try {
      const newLinks = await psGetSameDomainLinks(tab.id, domain, _crawlState.visited);
      _crawlState.queue.push(...newLinks);
    } catch(e) {
      console.warn('[crawl] could not get links from', url, e.message);
    }

    await new Promise(r => setTimeout(r, 1500));
  }

  _crawlState.running = false;
}

function normalizeUrl(url) {
  try {
    const u = new URL(url);
    u.hash = '';
    // remove trailing slash for consistency
    u.pathname = u.pathname.replace(/\/$/, '') || '/';
    return u.toString();
  } catch { return url; }
}

async function psGetSameDomainLinks(tabId, domain, visited) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: (domain) => {
      const seen = new Set();
      return Array.from(document.querySelectorAll('a[href]'))
        .map(a => { try { return new URL(a.href, location.href).href; } catch { return null; } })
        .filter(url => {
          if (!url) return false;
          try {
            const u = new URL(url);
            if (u.hostname !== domain) return false;
            if (u.hash && u.pathname === location.pathname) return false; // anchor-only link
            const key = u.origin + u.pathname;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          } catch { return false; }
        });
    },
    args: [domain]
  });
  const links = results?.[0]?.result || [];
  return links.filter(url => !visited.has(normalizeUrl(url)));
}

function waitForTabLoad(tabId) {
  return new Promise(resolve => {
    chrome.tabs.get(tabId, tab => {
      if (tab && tab.status === 'complete') { resolve(); return; }
      const listener = (id, info) => {
        if (id === tabId && info.status === 'complete') {
          chrome.tabs.onUpdated.removeListener(listener);
          resolve();
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
      // safety timeout
      setTimeout(resolve, 15000);
    });
  });
}
