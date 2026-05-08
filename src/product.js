import { load as loadHtml } from 'cheerio';
import { chromium } from 'playwright';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';

function cleanText(value = '') {
  return value.replace(/\s+/g, ' ').trim();
}

function isPlaceholderValue(value = '') {
  const text = cleanText(value).toLowerCase();
  return [
    '',
    'my cool app',
    'short one-line description (under 160 chars for seo)',
    'detailed description for directory sites that need more text. include key features, what makes it unique, and who it\'s for. can be multiple lines. some sites support markdown, others don\'t.',
    'feature 1',
    'feature 2',
    'feature 3',
  ].includes(text);
}

function truncate(value = '', max = 500) {
  const text = cleanText(value);
  return text.length > max ? `${text.slice(0, max - 1).trim()}…` : text;
}

function absoluteUrl(baseUrl, href) {
  try {
    if (!href || href === '#' || href.includes('undefined')) return '';
    return new URL(href, baseUrl).toString();
  } catch {
    return '';
  }
}

function slugify(value = '') {
  return String(value)
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/+$/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function inferEmailCandidatesFromDomain(url) {
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, '');
    return [
      `support@${hostname}`,
      `hello@${hostname}`,
    ];
  } catch {
    return [];
  }
}

function extractEmails(text = '') {
  const matches = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || [];
  return [...new Set(matches)];
}

function pickFirst(...values) {
  for (const value of values) {
    if (value && cleanText(value)) return cleanText(value);
  }
  return '';
}

function collectFeatures($) {
  const features = [];
  $('main li, section li').each((_, el) => {
    const text = cleanText($(el).text());
    if (text && text.length <= 120 && !features.includes(text)) {
      features.push(text);
    }
    if (features.length >= 5) return false;
  });
  return features;
}

function collectParagraphs($) {
  const parts = [];
  $('main p, article p, section p').each((_, el) => {
    const text = cleanText($(el).text());
    if (text && text.length >= 40) {
      parts.push(text);
    }
    if (parts.join('\n\n').length >= 600) return false;
  });
  return parts;
}

function scoreNameCandidate(value) {
  const text = cleanText(value);
  if (!text) return -1;
  let score = 0;
  if (text.length <= 24) score += 4;
  else if (text.length <= 40) score += 2;
  else if (text.length > 55) score -= 2;
  if (/^[A-Z0-9][A-Za-z0-9 .&+-]+$/.test(text)) score += 2;
  if (!/,/.test(text)) score += 1;
  if (!/api|branded links|shortener|campaign|social posts/i.test(text)) score += 2;
  if (/\bwiki\b/i.test(text)) score += 1;
  if (/\bfor\b/i.test(text) && text.length > 30) score -= 1;
  return score;
}

function guessProductName({ siteName, appName, ogTitle, h1, title, fallbackName }) {
  const rawCandidates = [
    siteName,
    appName,
    ogTitle,
    h1,
    title,
    ...(title ? title.split('|') : []),
    ...(title ? title.split('-') : []),
    fallbackName,
  ];

  const candidates = [...new Set(rawCandidates.map(cleanText).filter((value) => value && !isPlaceholderValue(value)))];
  if (!candidates.length) return '';

  candidates.sort((a, b) => scoreNameCandidate(b) - scoreNameCandidate(a) || a.length - b.length);
  return candidates[0];
}

export function parseProductFromHtml(url, html, baseProduct = {}) {
  const $ = loadHtml(html);
  const sanitizedBaseProduct = {
    ...baseProduct,
    name: isPlaceholderValue(baseProduct.name) ? '' : baseProduct.name,
    description: isPlaceholderValue(baseProduct.description) ? '' : baseProduct.description,
    long_description: isPlaceholderValue(baseProduct.long_description) ? '' : baseProduct.long_description,
    features: Array.isArray(baseProduct.features)
      ? baseProduct.features.filter((item) => !isPlaceholderValue(item))
      : [],
  };

  const title = $('title').first().text();
  const siteName = $('meta[property="og:site_name"]').attr('content');
  const ogTitle = $('meta[property="og:title"]').attr('content');
  const appName = $('meta[name="application-name"]').attr('content');
  const h1 = $('h1').first().text();

  const description = pickFirst(
    $('meta[name="description"]').attr('content'),
    $('meta[property="og:description"]').attr('content'),
    $('meta[name="twitter:description"]').attr('content'),
    $('main p').first().text(),
  );

  const paragraphs = collectParagraphs($);
  const longDescription = truncate(
    paragraphs.length ? paragraphs.slice(0, 3).join('\n\n') : description,
    900,
  );

  const bodyText = cleanText($('body').text());
  const challengeText = `${title} ${siteName} ${ogTitle} ${h1} ${bodyText}`.toLowerCase();
  if (
    /cloudflare|worker threw exception|attention required|just a moment|please enable cookies/i.test(challengeText)
  ) {
    throw new Error('Product page returned Cloudflare/challenge content');
  }
  const visibleEmails = extractEmails(bodyText);
  $('a[href^="mailto:"]').each((_, el) => {
    const href = $(el).attr('href') || '';
    const email = href.replace(/^mailto:/i, '').split('?')[0];
    if (email && !visibleEmails.includes(email)) visibleEmails.push(email);
  });

  const twitterLink = $('a[href*="twitter.com/"], a[href*="x.com/"]').first().attr('href');
  const githubLink = $('a[href*="github.com/"]').first().attr('href');
  const fallbackEmails = [
    ...(sanitizedBaseProduct._fallback_emails || []),
    sanitizedBaseProduct.email,
  ].filter(Boolean);
  const inferredEmails = inferEmailCandidatesFromDomain(url);

  const product = {
    ...sanitizedBaseProduct,
    name: guessProductName({
      siteName,
      appName,
      ogTitle,
      h1,
      title,
      fallbackName: sanitizedBaseProduct.name,
    }),
    url,
    description: truncate(pickFirst(description, title, sanitizedBaseProduct.description), 160),
    long_description: pickFirst(longDescription, description, sanitizedBaseProduct.long_description),
    email: pickFirst(visibleEmails[0], ...inferredEmails, ...fallbackEmails),
    twitter: pickFirst(absoluteUrl(url, twitterLink), sanitizedBaseProduct.twitter),
    github_url: pickFirst(absoluteUrl(url, githubLink), sanitizedBaseProduct.github_url),
    logo_url: pickFirst(
      absoluteUrl(url, $('meta[property="og:image"]').attr('content')),
      absoluteUrl(url, $('link[rel="icon"]').attr('href')),
      sanitizedBaseProduct.logo_url,
    ),
    features: sanitizedBaseProduct.features?.length ? sanitizedBaseProduct.features : collectFeatures($),
  };

  delete product._fallback_emails;

  return product;
}

function productCachePath(url) {
  return resolve('.product-cache', `${slugify(url)}.json`);
}

function readCachedProduct(url) {
  const cachePath = productCachePath(url);
  if (!existsSync(cachePath)) return null;
  try {
    return JSON.parse(readFileSync(cachePath, 'utf-8'));
  } catch {
    return null;
  }
}

function writeCachedProduct(url, product) {
  const cachePath = productCachePath(url);
  mkdirSync(resolve('.product-cache'), { recursive: true });
  writeFileSync(cachePath, JSON.stringify(product, null, 2));
}

export async function fetchProductFromUrl(url, baseProduct = {}) {
  let finalUrl = url;
  let html = '';

  try {
    const response = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(15000),
      headers: {
        'user-agent': 'Mozilla/5.0 (compatible; BacklinkPilot/2.1; +https://github.com/)',
      },
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    finalUrl = response.url || finalUrl;
    html = await response.text();
  } catch (error) {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
      });
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      finalUrl = page.url();
      html = await page.content();
    } catch {
      throw new Error(`Failed to fetch product URL: ${error.message}`);
    } finally {
      await browser.close();
    }
  }

  try {
    const product = parseProductFromHtml(finalUrl, html, baseProduct);
    writeCachedProduct(url, product);
    return product;
  } catch (error) {
    const cached = readCachedProduct(url);
    if (cached) return cached;
    throw error;
  }
}

export async function hydrateConfigProduct(config, productUrl) {
  if (!productUrl) return config;

  const resolvedUrl = /^https?:\/\//i.test(productUrl) ? productUrl : `https://${productUrl}`;
  const fallbackEmails = [
    ...(config.contact?.fallback_emails || []),
    config.contact?.fallback_email,
  ].filter(Boolean);
  const hydrated = await fetchProductFromUrl(resolvedUrl, {
    ...(config.product || {}),
    _fallback_emails: fallbackEmails,
  });

  return {
    ...config,
    product: {
      ...(config.product || {}),
      ...hydrated,
    },
    utm: {
      ...(config.utm || {}),
      base_url: resolvedUrl,
    },
    _productUrl: resolvedUrl,
  };
}

export function validateResolvedProduct(config) {
  const required = ['name', 'url', 'description', 'email'];
  for (const key of required) {
    if (!config.product?.[key]) {
      throw new Error(`Missing required product field after hydration: product.${key}`);
    }
  }
}
