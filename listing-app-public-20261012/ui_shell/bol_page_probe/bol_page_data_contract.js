(function () {
  var expectedId = __EXPECTED_PRODUCT_ID__;
  var now = new Date().toISOString();
  var path = location.origin + location.pathname;
  var canonicalLink = document.querySelector('link[rel="canonical"]');
  var canonicalUrl = null;
  try {
    if (canonicalLink && canonicalLink.href) {
      var parsedCanonical = new URL(canonicalLink.href, location.href);
      if ((parsedCanonical.hostname === 'bol.com' || parsedCanonical.hostname.endsWith('.bol.com')) && parsedCanonical.protocol === 'https:') {
        canonicalUrl = parsedCanonical.origin + parsedCanonical.pathname;
      }
    }
  } catch (_) {}
  function idFromUrl(value) {
    if (!value) return null;
    try {
      var match = new URL(value, location.href).pathname.match(/\/(\d{8,16})\/?$/);
      return match ? match[1] : null;
    } catch (_) { return null; }
  }
  var canonicalId = idFromUrl(canonicalUrl);
  var requestedId = String(expectedId || '').trim() || null;
  var productId = canonicalId || idFromUrl(location.href);
  function ref(selector) { return 'dom://' + location.host + location.pathname + '#selector=' + encodeURIComponent(selector); }
  function field(value, status, selector, note) {
    return { status: status, value: value === undefined ? null : value, evidence_ref: selector ? ref(selector) : null, note: note || null };
  }
  function text(el) { return el ? String(el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim() : ''; }
  function visible(el) {
    if (!el) return false;
    var r = el.getBoundingClientRect(), s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
  }
  function statusFor(value, partial) { return value ? (partial ? 'AVAILABLE_PARTIAL' : 'AVAILABLE_REAL') : 'UNKNOWN'; }
  var body = document.body;
  var bodyText = body ? String(body.innerText || '') : '';
  var canonicalStatus = canonicalUrl ? 'AVAILABLE_REAL' : 'UNKNOWN';
  var matchState = requestedId && canonicalId ? (requestedId === canonicalId ? 'true' : 'false') : 'unknown';

  var h1 = document.querySelector('h1');
  var title = text(h1) || document.title || '';

  var price = null;
  var priceSelector = '[data-test="price"], [data-testid*="price"], meta[itemprop="price"], [class*="promo-price"]';
  var priceMeta = document.querySelector('meta[itemprop="price"], meta[property="product:price:amount"]');
  if (priceMeta) price = priceMeta.getAttribute('content') || null;
  if (!price) {
    var priceNodes = Array.prototype.slice.call(document.querySelectorAll('[data-test="price"], [data-testid*="price"], [class*="promo-price"], [class*="price"]'));
    for (var pi = 0; pi < priceNodes.length; pi++) {
      var pv = text(priceNodes[pi]);
      if (visible(priceNodes[pi]) && pv && /(?:€|\d+[,.]\d{2})/.test(pv) && pv.length < 100) { price = pv; break; }
    }
  }
  if (!price) {
    var eur = bodyText.match(/De prijs van dit product is\s+(\d+)\s+euro en\s+(\d+)\s+cent/i);
    var symbol = bodyText.match(/€\s?(\d{1,4}(?:[,.]\d{2})?)/);
    if (eur) price = (parseInt(eur[1], 10) + parseInt(eur[2], 10) / 100).toFixed(2);
    else if (symbol) price = symbol[1];
  }

  var imageNodes = Array.prototype.slice.call(document.querySelectorAll('main img, [role="main"] img'));
  var images = [];
  for (var ii = 0; ii < imageNodes.length && images.length < 30; ii++) {
    var src = imageNodes[ii].currentSrc || imageNodes[ii].src || '';
    if (!src || !/^https:\/\//i.test(src)) continue;
    try {
      var imageUrl = new URL(src);
      if (!(imageUrl.hostname === 'bol.com' || imageUrl.hostname.endsWith('.bol.com') || imageUrl.hostname.endsWith('.s-bol.com') || imageUrl.hostname.endsWith('.bolcdn.nl'))) continue;
      images.push(imageUrl.origin + imageUrl.pathname);
    } catch (_) {}
  }
  var ogImage = document.querySelector('meta[property="og:image"]');
  if (!images.length && ogImage && ogImage.content) images.push(ogImage.content.split(/[?#]/)[0]);
  images = images.filter(function (v, i, a) { return a.indexOf(v) === i; });

  var descriptionSection = null;
  var sections = Array.prototype.slice.call(document.querySelectorAll('section'));
  for (var si = 0; si < sections.length; si++) {
    if (/Productbeschrijving|Product description/i.test(text(sections[si]))) { descriptionSection = sections[si]; break; }
  }
  var description = descriptionSection ? text(descriptionSection).replace(/^Productbeschrijving\s*/i, '').trim() : '';

  var specSection = null;
  for (var sj = 0; sj < sections.length; sj++) {
    if (/^Productspecificaties\b/i.test(text(sections[sj]))) { specSection = sections[sj]; break; }
  }
  var specRows = [];
  var specRoot = specSection || body;
  Array.prototype.slice.call(specRoot.querySelectorAll('tr')).forEach(function (row) {
    var cells = Array.prototype.slice.call(row.querySelectorAll('th,td')).map(text).filter(Boolean);
    if (cells.length >= 2) specRows.push({ label: cells[0], value: cells.slice(1).join(' | ') });
  });
  Array.prototype.slice.call(specRoot.querySelectorAll('dt')).forEach(function (dt) {
    var dd = dt.nextElementSibling;
    if (dd && dd.tagName && dd.tagName.toLowerCase() === 'dd') {
      var label = text(dt), value = text(dd);
      if (label && value) specRows.push({ label: label, value: value });
    }
  });
  var specMap = {};
  specRows.forEach(function (row) { if (!specMap[row.label]) specMap[row.label] = row.value; });
  var packagePair = null;
  Object.keys(specMap).some(function (key) {
    if (/aantal stuks|aantal artikelen in verpakking|inhoud|set bevat|stuks in de set|stuks in verpakking|package contents/i.test(key)) {
      packagePair = { label: key, value: specMap[key] };
      return true;
    }
    return false;
  });
  if (!packagePair) {
    var quantity = (title + '\n' + description).match(/\b(\d{1,3})\s*(?:stuks|st\.)\b/i);
    if (quantity) packagePair = { label: 'quantity from page title/description', value: quantity[1] + ' stuks' };
  }

  var eanMatch = bodyText.match(/\b(?:EAN|GTIN)\s*:?\s*(\d{8,14})\b/i);
  var reviewsSection = document.querySelector('[data-testid="reviews"]');
  if (!reviewsSection) reviewsSection = sections.filter(function (s) { return /^Reviews\b/i.test(text(s)); })[0] || null;
  var reviewsText = text(reviewsSection);
  var noReviews = /nog geen reviews|geen reviews/i.test(reviewsText);
  var countMatch = reviewsText.match(/(?:uit\s+)?(\d+)\s+reviews?/i);
  var reviewCount = noReviews ? 0 : (countMatch ? parseInt(countMatch[1], 10) : null);
  var reviewCards = Array.prototype.slice.call(document.querySelectorAll('[data-testid="review-details"]'));
  if (!reviewCards.length && reviewsSection) reviewCards = Array.prototype.slice.call(reviewsSection.querySelectorAll('[class*="review-details"], [class*="review-card"]'));
  var reviewItems = reviewCards.slice(0, 20).map(function (card) {
    var cardText = text(card);
    var firstDiv = card.querySelector('div');
    var reviewTitle = text(firstDiv);
    var bodyNode = Array.prototype.slice.call(card.querySelectorAll('p')).filter(function (p) { return !/^Geschreven bij:/i.test(text(p)); })[0];
    var reviewBody = text(bodyNode);
    var dateSource = String(card.textContent || card.innerText || '').replace(/[\s\u00a0\u202f]+/g, ' ');
    var dateMatch = dateSource.match(/\d{1,2}\s*(?:januari|februari|maart|april|mei|juni|juli|augustus|september|oktober|november|december)\s*\d{4}/i);
    var aria = card.querySelector('[aria-label*="ster" i]');
    var ariaText = aria ? aria.getAttribute('aria-label') : '';
    var ratingMatch = ariaText.match(/(\d+(?:[,.]\d+)?)\s+van de\s+(\d+)/i);
    return {
      title: field(reviewTitle || null, statusFor(reviewTitle, false), '[data-testid=review-details] div:first-child'),
      body: field(reviewBody || null, statusFor(reviewBody, false), '[data-testid=review-details] p'),
      date: field(dateMatch ? dateMatch[0] : null, dateMatch ? 'AVAILABLE_REAL' : 'UNKNOWN', '[data-testid=review-details]'),
      rating: field(ratingMatch ? { value: ratingMatch[1].replace(',', '.'), scale: parseInt(ratingMatch[2], 10) } : null, ratingMatch ? 'AVAILABLE_REAL' : 'UNKNOWN', '[data-testid=review-details] [aria-label]')
    };
  });
  var averageRating = null;
  var averageMatch = reviewsText.match(/Gemiddeld\s+(\d+(?:[,.]\d+)?)\s+van de\s+(\d+)\s+sterren/i);
  if (averageMatch) averageRating = { value: averageMatch[1].replace(',', '.'), scale: parseInt(averageMatch[2], 10) };
  if (!averageRating) {
    var ratingLabel = reviewsSection && reviewsSection.querySelector('[aria-label*="klantbeoordeling" i]');
    var ratingLabelText = ratingLabel ? ratingLabel.getAttribute('aria-label') : '';
    var singleRating = ratingLabelText.match(/(\d+(?:[,.]\d+)?)\s+van de\s+(\d+)/i);
    if (singleRating) averageRating = { value: singleRating[1].replace(',', '.'), scale: parseInt(singleRating[2], 10) };
  }
  var nextControl = reviewsSection && Array.prototype.slice.call(reviewsSection.querySelectorAll('button,a,[aria-label]')).some(function (el) {
    return /volgende|next page|meer reviews|load more/i.test(text(el) + ' ' + (el.getAttribute('aria-label') || ''));
  });
  var reviewStatus = noReviews ? 'NO_REVIEWS' : (reviewCount !== null || reviewItems.length ? 'AVAILABLE_REAL' : 'UNKNOWN');
  var pagination = noReviews ? field(null, 'NOT_PRESENT', '[data-testid=reviews]') :
    (nextControl ? field('next/load-more control present', 'AVAILABLE_REAL', '[data-testid=reviews] button,a,[aria-label]') :
      field(null, 'UNKNOWN', '[data-testid=reviews]', 'No multi-page control observed; pagination cannot be validated from this page.'));

  var sellerMatch = bodyText.match(/(?:Verkocht door|Verkoop door)\s*:?\s*([^\n\r]{2,100})/i);
  var seller = sellerMatch ? sellerMatch[1].replace(/^(?:Verkoop door|Verkocht door)\s*:?\s*/i, '').replace(/\s+beoordeeld met.*$/i, '').trim() : '';
  var sellerRatingMatch = bodyText.match(/(?:Verkoop door|Verkocht door)\s+[^\n\r]{1,80}?beoordeeld met een\s+(\d+(?:[,.]\d+)?)\s+uit\s+10/i) || bodyText.match(/(?:verkopersbeoordeling|seller rating)\s*:?\s*(\d+(?:[,.]\d+)?)\s*(?:\/|van de)\s*5/i);
  var deliveryMatch = bodyText.match(/(?:morgen in huis|voor\s+\d{1,2}:?\d{0,2}\s+besteld[^\n]{0,80}|binnen\s+\d+\s+werkdagen[^\n]{0,80}|op voorraad[^\n]{0,80})/i);
  var fulfilmentMatch = bodyText.match(/(?:verkoop en verzending door|verkocht door[^\n]{0,80}verzonden door)\s*([^\n]{2,120})/i);

  var evidence = [
    { field: 'product_id/canonical_url', selector: 'link[rel=canonical]' },
    { field: 'title', selector: 'h1' },
    { field: 'ean_gtin', selector: 'body text matching EAN/GTIN' },
    { field: 'current_price', selector: priceSelector },
    { field: 'main_image/image_list', selector: 'main img, [role=main] img, meta[property=og:image]' },
    { field: 'description', selector: 'section containing Productbeschrijving' },
    { field: 'specifications/package_or_set_content', selector: 'section containing Productspecificaties; tr; dl' },
    { field: 'rating/reviews', selector: '[data-testid=reviews], [data-testid=review-details]' },
    { field: 'seller/delivery/fulfilment', selector: 'visible page text and offer section' }
  ].map(function (e) { return { field: e.field, selector: e.selector, ref: ref(e.selector) }; });

  var result = {
    requested_product_id: field(requestedId, requestedId ? 'AVAILABLE_REAL' : 'UNKNOWN', 'navigate.expected_product_id'),
    canonical_product_id: field(canonicalId, canonicalId ? 'AVAILABLE_REAL' : 'UNKNOWN', 'link[rel=canonical]'),
    product_id_match: field(matchState, matchState === 'unknown' ? 'UNKNOWN' : 'AVAILABLE_REAL', 'expected_product_id compared with canonical_product_id'),
    product_id: field(productId, productId ? 'AVAILABLE_REAL' : 'UNKNOWN', 'link[rel=canonical]'),
    canonical_url: field(canonicalUrl, canonicalStatus, 'link[rel=canonical]'),
    ean_gtin: field(eanMatch ? eanMatch[1] : null, eanMatch ? 'AVAILABLE_REAL' : 'UNKNOWN', 'body text matching EAN/GTIN'),
    title: field(title || null, title ? (h1 ? 'AVAILABLE_REAL' : 'AVAILABLE_PARTIAL') : 'UNKNOWN', h1 ? 'h1' : 'document.title'),
    current_price: field(price || null, price ? 'AVAILABLE_REAL' : 'UNKNOWN', priceSelector),
    main_image: field(images.length ? images[0] : null, images.length ? 'AVAILABLE_REAL' : 'UNKNOWN', 'main img, [role=main] img, meta[property=og:image]'),
    image_list: field(images, images.length ? 'AVAILABLE_PARTIAL' : 'UNKNOWN', 'main img, [role=main] img, img'),
    description: field(description ? description.slice(0, 450) : null, description ? (description.length > 450 ? 'AVAILABLE_PARTIAL' : 'AVAILABLE_REAL') : 'UNKNOWN', 'section containing Productbeschrijving'),
    specifications: field(specRows.length ? specRows : null, specRows.length ? 'AVAILABLE_PARTIAL' : 'UNKNOWN', 'section containing Productspecificaties; tr; dl'),
    package_or_set_content: field(packagePair, packagePair ? (packagePair.label.indexOf('quantity from') === 0 ? 'AVAILABLE_PARTIAL' : 'AVAILABLE_REAL') : 'UNKNOWN', 'specification row or product title/description'),
    rating: field(averageRating, averageRating ? 'AVAILABLE_REAL' : (noReviews ? 'NOT_PRESENT' : 'UNKNOWN'), '[data-testid=reviews]'),
    review_count: field(reviewCount, reviewCount !== null ? 'AVAILABLE_REAL' : 'UNKNOWN', '[data-testid=reviews]'),
    reviews: {
      status: reviewStatus === 'NO_REVIEWS' ? 'NOT_PRESENT' : (reviewStatus === 'AVAILABLE_REAL' ? 'AVAILABLE_REAL' : 'UNKNOWN'),
      reviews_status: reviewStatus,
      review_count: field(reviewCount, reviewCount !== null ? 'AVAILABLE_REAL' : 'UNKNOWN', '[data-testid=reviews]'),
      items: reviewItems,
      pagination_status: pagination
    },
    seller: field(seller || null, seller ? 'AVAILABLE_REAL' : 'UNKNOWN', 'offer section text matching seller'),
    seller_rating: field(sellerRatingMatch ? { value: sellerRatingMatch[1].replace(',', '.'), scale: /uit\s+10/i.test(sellerRatingMatch[0]) ? 10 : 5 } : null, sellerRatingMatch ? 'AVAILABLE_REAL' : 'UNKNOWN', 'offer section text matching seller rating'),
    delivery_text: field(deliveryMatch ? deliveryMatch[0] : null, deliveryMatch ? 'AVAILABLE_PARTIAL' : 'UNKNOWN', 'offer section delivery text'),
    fulfilment: field(fulfilmentMatch ? fulfilmentMatch[0] : null, fulfilmentMatch ? 'AVAILABLE_PARTIAL' : 'UNKNOWN', 'offer section fulfilment text'),
    current_offer: field(price ? { price: price, seller: seller || null, delivery_text: deliveryMatch ? deliveryMatch[0] : null, fulfilment: fulfilmentMatch ? fulfilmentMatch[0] : null } : null, price ? 'AVAILABLE_PARTIAL' : 'UNKNOWN', 'price/seller/delivery offer fields'),
    checked_at: now,
    page_ready_state: field(document.readyState, document.readyState === 'complete' ? 'AVAILABLE_REAL' : 'AVAILABLE_PARTIAL', 'document.readyState'),
    dom_evidence_refs: evidence
  };
  return JSON.stringify(result);
})()
