const PRECHECK_TIMEOUT_MS = 12000;

function countMatches(text, regex) {
  return (text.match(regex) || []).length;
}

export async function preflightSite(url) {
  try {
    const response = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(PRECHECK_TIMEOUT_MS),
    });
    const html = await response.text();
    const lower = html.toLowerCase();

    const formCount = countMatches(lower, /<form\b/g);
    const inputCount = countMatches(lower, /<input\b/g);
    const textareaCount = countMatches(lower, /<textarea\b/g);
    const submitCount = countMatches(lower, /type=["']submit["']/g);
    const hasEmail = /type=["']email["']|name=["'][^"']*email/i.test(html);
    const hasDescription = /<textarea\b|name=["'][^"']*(description|desc|about|summary)/i.test(html);
    const hasGuideLanguage =
      /browse the directory to identify|submit url link|submission guidelines|how to make a site submission/i.test(lower);
    const hasCaptcha = /captcha|recaptcha|turnstile|verify you are human/i.test(lower);
    const finalPath = (() => {
      try {
        return new URL(response.url).pathname.toLowerCase();
      } catch {
        return '';
      }
    })();
    const hasLogin = /sign in|log in|login|create account|register|google oauth|continue with google/i.test(lower) ||
      /\/(login|signin|sign-in|register|signup|sign-up)(\.php)?\/?$/.test(finalPath);
    const directFormLikely =
      formCount > 0 &&
      !hasGuideLanguage &&
      !hasCaptcha &&
      !hasLogin &&
      (textareaCount > 0 || hasEmail || inputCount >= 6);

    let reason = 'direct_form_likely';
    if (!response.ok) reason = `http_${response.status}`;
    else if (hasGuideLanguage) reason = 'guide_page';
    else if (hasCaptcha) reason = 'captcha_detected';
    else if (hasLogin) reason = 'login_detected';
    else if (!directFormLikely) reason = 'weak_form_signals';

    return {
      ok: response.ok,
      status: response.status,
      finalUrl: response.url,
      directFormLikely,
      reason,
      signals: {
        formCount,
        inputCount,
        textareaCount,
        submitCount,
        hasEmail,
        hasDescription,
        hasGuideLanguage,
        hasCaptcha,
        hasLogin,
        finalPath,
      },
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      finalUrl: url,
      directFormLikely: false,
      reason: 'fetch_failed',
      error: error.message,
      signals: null,
    };
  }
}
