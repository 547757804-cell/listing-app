import zlib from 'node:zlib';
import path from 'node:path';

const HEADER_ALIASES = new Map([
  ['产品id', 'product_id'], ['product id', 'product_id'],
  ['产品sku', 'sku'], ['sku', 'sku'], ['产品ean', 'ean'], ['ean', 'ean'],
  ['品牌名', 'brand_name'], ['品牌', 'brand_name'], ['brand', 'brand_name'], ['brand name', 'brand_name'],
  ['中文名称', 'name'], ['产品名称', 'name'], ['product name', 'name'],
  ['产品分类', 'category'], ['采购名称', 'procurement_name'], ['包装尺寸', 'packaging_size'],
  // Historical header retained for compatibility; its business meaning is an owned-fact source.
  ['1688采购链接', 'owned_product_source'], ['自有产品来源', 'owned_product_source'], ['bol直接竞品', 'bol_direct_competitor'],
  ['bol同类竞品1', 'bol_similar_competitor_1'], ['bol同类竞品2', 'bol_similar_competitor_2'],
  ['bol同类竞品3', 'bol_similar_competitor_3'], ['bol同类竞品4', 'bol_similar_competitor_4'],
  ['amazon参考', 'amazon_reference'], ['系列共通信息', 'series_info'], ['资料状态', 'source_status'],
  ['日期', 'source_date'], ['备注', 'notes'], ['1688 sku截图/文件', '1688_sku_reference'],
  ['1688参数属性截图/文件', '1688_attributes_reference'], ['1688尺寸容量图/文件', '1688_dimensions_reference'],
  ['1688包装内容截图/文件', '1688_packaging_reference'], ['自有产品图片/文件', 'own_product_image_reference'],
  ['直接竞品关键词截图/文件', 'bol_direct_keyword_reference'], ['同类竞品关键词截图/文件', 'bol_similar_keyword_reference_1'],
  ['同类竞品关键词截图/文件2', 'bol_similar_keyword_reference_2'], ['同类竞品关键词截图/文件3', 'bol_similar_keyword_reference_3'],
  ['同类竞品关键词截图/文件4', 'bol_similar_keyword_reference_4'], ['amazon参考补充资料', 'amazon_supplementary_reference'],
  ['amazon描述参考', 'amazon_description_reference'], ['bol竞品描述参考', 'bol_description_reference'],
]);

const REQUIRED_CANONICAL = ['product_id', 'sku', 'ean', 'brand_name', 'name', 'owned_product_source', 'bol_direct_competitor', 'amazon_reference'];

function xmlDecode(value = '') {
  return value.replace(/&#x([\da-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

function attr(tag, name) {
  const m = tag.match(new RegExp(`(?:^|\\s)${name}="([^"]*)"`));
  return m ? xmlDecode(m[1]) : null;
}

function columnNumber(ref = '') {
  const letters = String(ref).match(/^[A-Z]+/i)?.[0]?.toUpperCase() || '';
  let value = 0;
  for (const ch of letters) value = value * 26 + ch.charCodeAt(0) - 64;
  return value;
}

function zipEntries(buffer) {
  const min = Math.max(0, buffer.length - 65_557);
  let eocd = -1;
  for (let i = buffer.length - 22; i >= min; i--) if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw Object.assign(new Error('XLSX ZIP目录损坏或不受支持。'), { code: 'XLSX_ZIP_INVALID' });
  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let i = 0; i < count; i++) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw Object.assign(new Error('XLSX ZIP目录条目无效。'), { code: 'XLSX_ZIP_INVALID' });
    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString((flags & 0x0800) ? 'utf8' : 'latin1');
    if (flags & 1) throw Object.assign(new Error('不支持加密的XLSX文件。'), { code: 'XLSX_ENCRYPTED' });
    if (compressedSize === 0xffffffff || localOffset === 0xffffffff) throw Object.assign(new Error('不支持Zip64 XLSX文件。'), { code: 'XLSX_ZIP64_UNSUPPORTED' });
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = buffer.subarray(dataStart, dataStart + compressedSize);
    let data;
    if (method === 0) data = Buffer.from(compressed);
    else if (method === 8) data = zlib.inflateRawSync(compressed);
    else throw Object.assign(new Error(`XLSX压缩方式${method}不受支持。`), { code: 'XLSX_COMPRESSION_UNSUPPORTED' });
    entries.set(name.replace(/^\//, ''), data);
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function decodeSharedStrings(xml) {
  if (!xml) return [];
  return [...xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map(([, item]) => [...item.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map(([, text]) => xmlDecode(text)).join(''));
}

function parseXmlRows(xml, sharedStrings) {
  const rows = new Map();
  for (const [, rowTag, rowNumber, body = ''] of xml.matchAll(/(<row\b[^>]*\br="(\d+)"[^>]*)(?:>([\s\S]*?)<\/row>|\s*\/)/g)) {
    const rowNo = Number(rowNumber || attr(rowTag, 'r'));
    const cells = new Map();
    for (const [, openTag, content = ''] of body.matchAll(/(<c\b[^>]*)(?:>([\s\S]*?)<\/c>|\s*\/)/g)) {
      const ref = attr(openTag, 'r');
      const col = columnNumber(ref);
      if (!col) continue;
      const type = attr(openTag, 't');
      const formula = content?.match(/<f\b[^>]*>([\s\S]*?)<\/f>/)?.[1];
      const val = content?.match(/<v\b[^>]*>([\s\S]*?)<\/v>/)?.[1];
      const inline = content?.match(/<is\b[^>]*>([\s\S]*?)<\/is>/)?.[1];
      let value = val == null ? null : xmlDecode(val);
      if (type === 's' && value != null) value = sharedStrings[Number(value)] ?? value;
      else if (type === 'inlineStr' && inline != null) value = [...inline.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map(([, text]) => xmlDecode(text)).join('');
      else if (type === 'b' && value != null) value = value === '1';
      if (formula != null) value = value == null || value === '' ? `=${xmlDecode(formula)}` : value;
      cells.set(col, { value, formula: formula == null ? null : xmlDecode(formula), ref });
    }
    rows.set(rowNo, cells);
  }
  return rows;
}

function normalizeHeader(text) { return String(text ?? '').trim().replace(/[\s　]+/g, ' ').toLowerCase(); }

export function classifyOwnedProductSource(rawValue, formula = null) {
  const raw = String(rawValue ?? '').trim();
  if (!raw) return 'MISSING';
  if (formula && /dispimg/i.test(formula)) return 'SOURCE_IMAGE';
  const parts = raw.split(/\r?\n/).map(item => item.trim()).filter(Boolean);
  const types = new Set(parts.map(part => {
    const parsed = parseHttpUrl(part);
    if (parsed) {
      if (/(^|\.)1688\.com$/i.test(parsed.hostname)) return 'OWN_SOURCE_1688';
      if (/(^|\.)bol\.com$/i.test(parsed.hostname)) return 'OWN_SOURCE_BOL_IDENTICAL';
      return 'SOURCE_URL';
    }
    if (/^(?:file|material):\/\//i.test(part) || /(?:^|[\\/])[^\\/]+\.(?:pdf|docx?|xlsx?|csv|png|jpe?g|webp)(?:[?#].*)?$/i.test(part)) {
      return /\.(?:png|jpe?g|webp)(?:[?#].*)?$/i.test(part) ? 'SOURCE_IMAGE' : 'SOURCE_FILE';
    }
    return 'OWN_SOURCE_TEXT';
  }));
  if (types.size > 1) return 'MIXED';
  return [...types][0] || 'EMPTY';
}

function parseHttpUrl(raw) {
  const value = String(raw || '').trim();
  if (!value) return null;
  const candidate = /^https?:\/\//i.test(value) ? value : /^[\w.-]+\.[a-z]{2,}(?:[/:?#]|$)/i.test(value) ? `https://${value}` : null;
  if (!candidate) return null;
  try {
    const parsed = new URL(candidate);
    return ['http:', 'https:'].includes(parsed.protocol) ? parsed : null;
  } catch { return null; }
}
function isBolUrl(raw) { return /(^|\.)bol\.com$/i.test(parseHttpUrl(raw)?.hostname || ''); }
function isAmazonUrl(raw) { return /(^|\.)amazon\.[a-z.]+$/i.test(parseHttpUrl(raw)?.hostname || ''); }

function findSheetPaths(entries) {
  const workbook = entries.get('xl/workbook.xml')?.toString('utf8');
  const rels = entries.get('xl/_rels/workbook.xml.rels')?.toString('utf8');
  if (!workbook || !rels) throw Object.assign(new Error('XLSX缺少workbook结构。'), { code: 'XLSX_WORKBOOK_INVALID' });
  const relationMap = new Map();
  for (const match of rels.matchAll(/<Relationship\b[^>]*\/?\s*>/g)) {
    const tag = match[0];
    const id = attr(tag, 'Id'); const target = attr(tag, 'Target');
    if (id && target) {
      const normalizedTarget = target.replace(/^\/+/, '');
      const packagePath = normalizedTarget.startsWith('xl/') ? normalizedTarget : path.posix.join('xl', normalizedTarget);
      relationMap.set(id, path.posix.normalize(packagePath));
    }
  }
  const sheets = [];
  for (const match of workbook.matchAll(/<sheet\b[^>]*\/?\s*>/g)) {
    const tag = match[0];
    const name = attr(tag, 'name'); const id = attr(tag, 'r:id');
    if (name && id && relationMap.has(id)) sheets.push({ name, path: relationMap.get(id) });
  }
  return sheets;
}

function rowValues(cells, width) {
  return Array.from({ length: width }, (_, index) => cells.get(index + 1)?.value ?? null);
}

export function inspectSourceWorkbook(buffer, { sourceFile = 'uploaded-workbook.xlsx', importVersion = 1, importedAt = new Date().toISOString(), previousSchema = null, productIds = null } = {}) {
  const entries = zipEntries(Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer));
  const sharedStrings = decodeSharedStrings(entries.get('xl/sharedStrings.xml')?.toString('utf8'));
  const sheetDescriptors = findSheetPaths(entries);
  const sheetData = sheetDescriptors.map(sheet => ({ ...sheet, rows: parseXmlRows(entries.get(sheet.path)?.toString('utf8') || '', sharedStrings) }));
  const requiredHeaders = new Set(['product_id', 'sku', 'ean', 'name']);
  const candidates = [];
  for (const sheet of sheetData) for (const [rowNo, cells] of sheet.rows) {
    const headers = rowValues(cells, Math.max(1, ...cells.keys()));
    const mapped = headers.map(value => HEADER_ALIASES.get(normalizeHeader(value)) || null);
    const set = new Set(mapped.filter(Boolean));
    if ([...requiredHeaders].every(header => set.has(header))) candidates.push({ sheet, headerRow: rowNo, headers, mapped });
  }
  if (candidates.length !== 1) {
    const issue = candidates.length ? 'SOURCE_SCHEMA_AMBIGUOUS' : 'SOURCE_SCHEMA_HEADER_NOT_FOUND';
    return { status: 'FAIL', code: issue, message: '无法唯一识别包含产品ID、SKU、EAN和产品名称字段的表头行。', sheets: sheetDescriptors.map(({ name }) => name), rows: [], schema: null };
  }
  const { sheet, headerRow, headers, mapped } = candidates[0];
  const headerIssues = [];
  const seenHeaders = new Set(); const seenCanonical = new Set();
  headers.forEach((header, index) => {
    const normalized = normalizeHeader(header);
    const canonical = HEADER_ALIASES.get(normalized);
    if (!normalized) headerIssues.push({ code: 'HEADER_BLANK', header_index: index + 1, header_name: header });
    if (seenHeaders.has(normalized)) headerIssues.push({ code: 'HEADER_DUPLICATE', header_index: index + 1, header_name: header });
    seenHeaders.add(normalized);
    if (canonical && seenCanonical.has(canonical)) headerIssues.push({ code: 'CANONICAL_HEADER_DUPLICATE', header_index: index + 1, header_name: header, canonical_field: canonical });
    if (canonical) seenCanonical.add(canonical);
  });
  for (const required of REQUIRED_CANONICAL) if (!seenCanonical.has(required)) headerIssues.push({ code: 'REQUIRED_HEADER_MISSING', canonical_field: required });
  const dataRows = [];
  const skuRows = new Map();
  const scopedProductIds = productIds ? new Set(productIds.map(value => String(value).trim())) : null;
  const productRows = [...sheet.rows.entries()].filter(([rowNo]) => rowNo > headerRow).sort(([a], [b]) => a - b);
  for (const [rowNo, cells] of productRows) {
    const values = rowValues(cells, headers.length);
    const nonempty = [...cells.values()].some(cell => cell.value != null && String(cell.value).trim() !== '');
    if (!nonempty) continue;
    const idColumn = mapped.indexOf('product_id');
    const idValue = String(values[idColumn] ?? '').trim();
    const skuColumn = mapped.indexOf('sku');
    const skuValue = String(values[skuColumn] ?? '').trim();
    if (scopedProductIds && !scopedProductIds.has(idValue) && !scopedProductIds.has(skuValue)) continue;
    const raw = {};
    const fieldMeta = {};
    for (let i = 0; i < headers.length; i++) {
      const header = headers[i]; const value = values[i]; const canonical = mapped[i];
      raw[header] = value;
      if (canonical) fieldMeta[canonical] = { raw_value: value, source_file: sourceFile, sheet: sheet.name, header_name: header, import_version: importVersion, imported_at: importedAt, cell_reference: cells.get(i + 1)?.ref || null, formula: cells.get(i + 1)?.formula || null };
    }
    const productId = String(fieldMeta.product_id?.raw_value ?? '').trim();
    const sku = String(fieldMeta.sku?.raw_value ?? '').trim();
    if (!productId && !sku) {
      dataRows.push({ row_number: rowNo, product_id: '', sku: '', raw_values: raw, fields: fieldMeta, status: 'ROW_ALIGNMENT_ERROR', issues: [{ code: 'ROW_ALIGNMENT_ERROR', field: 'product_id/sku', message: '该行含业务单元格，但产品ID和SKU均为空。', suggested_cells: ['A行产品ID', 'C行产品sku'] }] });
      continue;
    }
    const issues = [];
    for (const cell of cells.values()) if (columnNumber(cell.ref) > headers.length && cell.value != null && String(cell.value).trim() !== '') issues.push({ code: 'ROW_ALIGNMENT_ERROR', field: 'row_width', cell: cell.ref, message: '数据单元格超出已识别表头范围。' });
    if (!sku) issues.push({ code: 'ROW_ALIGNMENT_ERROR', field: 'sku', message: '产品ID存在但产品SKU为空。', suggested_cells: [`C${rowNo}`] });
    const ean = String(fieldMeta.ean?.raw_value ?? '').trim();
    if (ean && !/^\d{8}(?:\d{5})?(?:\d)?$/.test(ean)) issues.push({ code: 'SOURCE_SCHEMA_MISMATCH', field: 'ean', message: '产品EAN不是8、13或14位纯数字。', suggested_cells: [`D${rowNo}`] });
    const packageSize = String(fieldMeta.packaging_size?.raw_value ?? '').trim();
    if (/^https?:\/\//i.test(packageSize) || packageSize.length > 250) issues.push({ code: 'SOURCE_SCHEMA_MISMATCH', field: 'packaging_size', message: /^https?:\/\//i.test(packageSize) ? '包装尺寸字段内容为URL。' : '包装尺寸字段是长段描述，不像尺寸值。', suggested_cells: [`H${rowNo}`] });
    const ownedSource = fieldMeta.owned_product_source;
    if (ownedSource) ownedSource.content_type = classifyOwnedProductSource(ownedSource.raw_value, ownedSource.formula);
    for (const field of ['bol_direct_competitor', 'bol_similar_competitor_1', 'bol_similar_competitor_2', 'bol_similar_competitor_3', 'bol_similar_competitor_4']) {
      const value = String(fieldMeta[field]?.raw_value ?? '').trim();
      if (value && !isBolUrl(value)) issues.push({ code: 'SOURCE_SCHEMA_MISMATCH', field, message: 'BOL竞品字段不是BOL URL。', suggested_cells: [fieldMeta[field]?.cell_reference || `${field}@row${rowNo}`] });
    }
    const amazon = String(fieldMeta.amazon_reference?.raw_value ?? '').trim();
    if (amazon && !isAmazonUrl(amazon)) issues.push({ code: 'SOURCE_SCHEMA_MISMATCH', field: 'amazon_reference', message: 'Amazon参考字段不是Amazon URL。', suggested_cells: [fieldMeta.amazon_reference?.cell_reference || `amazon_reference@row${rowNo}`] });
    const brand = String(fieldMeta.brand_name?.raw_value ?? '').trim();
    const status = issues.length ? issues.some(item => item.code === 'ROW_ALIGNMENT_ERROR') ? 'ROW_ALIGNMENT_ERROR' : 'SOURCE_SCHEMA_MISMATCH' : brand ? 'PASS' : 'WAITING_CONFIRMATION';
    const duplicateKey = sku.toLowerCase();
    if (sku) {
      if (skuRows.has(duplicateKey)) {
        const prior = dataRows[skuRows.get(duplicateKey)];
        prior.issues.push({ code: 'SKU_DUPLICATE', field: 'sku', message: `SKU同时出现在第${prior.row_number}和第${rowNo}行。` });
        prior.status = 'SOURCE_SCHEMA_MISMATCH';
        issues.push({ code: 'SKU_DUPLICATE', field: 'sku', message: `SKU同时出现在第${skuRows.get(duplicateKey)}和第${rowNo}行。` });
      } else skuRows.set(duplicateKey, dataRows.length);
    }
    dataRows.push({ row_number: rowNo, product_id: productId, sku, raw_values: raw, fields: fieldMeta, status, issues });
  }
  const schemaFingerprint = headers.map(normalizeHeader).join('|');
  const currentPositions = Object.fromEntries(mapped.map((field, index) => field ? [field, index + 1] : null).filter(Boolean));
  const previousPositions = previousSchema?.canonical_positions || null;
  const movedFields = previousPositions ? Object.keys(previousPositions).filter(field => currentPositions[field] && Number(previousPositions[field]) !== Number(currentPositions[field])) : [];
  const hasAlignmentError = dataRows.some(row => row.status === 'ROW_ALIGNMENT_ERROR');
  const hasSchemaMismatch = dataRows.some(row => row.status === 'SOURCE_SCHEMA_MISMATCH');
  return {
    status: headerIssues.length || hasAlignmentError || hasSchemaMismatch ? 'FAIL' : 'PASS',
    code: headerIssues.length || hasSchemaMismatch ? 'SOURCE_SCHEMA_MISMATCH' : hasAlignmentError ? 'ROW_ALIGNMENT_ERROR' : null,
    source_file: sourceFile, import_version: importVersion, imported_at: importedAt,
    schema: { sheet: sheet.name, header_row: headerRow, headers, canonical_positions: currentPositions, schema_fingerprint: schemaFingerprint, order_changed: movedFields.length > 0, order_change_fields: movedFields, added_headers: previousSchema ? headers.filter(header => !previousSchema.headers?.includes(header)) : [], removed_headers: previousSchema ? previousSchema.headers.filter(header => !headers.includes(header)) : [], header_issues: headerIssues },
    sheets: sheetDescriptors.map(({ name }) => name), rows: dataRows,
  };
}

export function normalizeSourceWorkbookRows(report, { sourceFilePath, sourceFileHash } = {}) {
  return (report.rows || []).filter(row => ['PASS', 'WAITING_CONFIRMATION'].includes(row.status)).map(row => {
    const value = key => row.fields?.[key]?.raw_value ?? null;
    const competitorFields = ['bol_direct_competitor', 'bol_similar_competitor_1', 'bol_similar_competitor_2', 'bol_similar_competitor_3', 'bol_similar_competitor_4'];
    const competitorUrls = competitorFields.flatMap(key => {
      const raw = String(value(key) ?? '').trim();
      return raw ? [{ source_header: row.fields[key].header_name, source_cell: row.fields[key].cell_reference, exact_url: raw, import_version: report.import_version }] : [];
    });
    const uniqueUrls = [];
    for (const item of competitorUrls) {
      const duplicate = uniqueUrls.find(existing => existing.exact_url === item.exact_url);
      if (duplicate) item.duplicate_of = duplicate.source_cell;
      else uniqueUrls.push(item);
    }
    const ownedSource = row.fields?.owned_product_source || { raw_value: null, content_type: 'MISSING' };
    const extraFields = {};
    for (const [key, item] of Object.entries(row.fields || {})) {
      if (!['product_id','sku','ean','brand_name','name','category','procurement_name','packaging_size','owned_product_source', ...competitorFields, 'amazon_reference'].includes(key)) extraFields[key] = structuredClone(item);
    }
    return {
      product_id: row.product_id,
      sku: row.sku,
      ean: value('ean'),
      name: value('name'),
      brand_name: value('brand_name'),
      product_facts: {
        category: value('category'), procurement_name: value('procurement_name'), packaging_size: value('packaging_size'),
        owned_product_source_content: { raw_value: ownedSource.raw_value, content_type: ownedSource.content_type, source_file: sourceFilePath || report.source_file, sheet: report.schema.sheet, header_name: ownedSource.header_name || '1688采购链接', import_version: report.import_version, imported_at: report.imported_at },
        amazon_reference: value('amazon_reference'), extra_source_fields: extraFields,
      },
      source_refs: ['OWN_SOURCE_1688', 'OWN_SOURCE_BOL_IDENTICAL'].includes(ownedSource.content_type) ? [String(ownedSource.raw_value)] : [],
      competitor_urls: uniqueUrls,
      competitor_url_completion: uniqueUrls.length ? { status: 'NOT_REQUIRED', reason: null, candidates: [] } : { status: 'WAITING_DEPENDENCY', reason: 'NO_EXISTING_BOL_COMPETITOR_URL', dependency: 'LISTING_SOP_03_EXECUTOR', candidates: [] },
      excel_source_import: {
        version: report.import_version, imported_at: report.imported_at, source_file: sourceFilePath || report.source_file,
        source_file_hash: sourceFileHash || null, sheet: report.schema.sheet, header_row: report.schema.header_row,
        row_number: row.row_number, schema_fingerprint: report.schema.schema_fingerprint,
        headers: structuredClone(report.schema.headers), canonical_positions: structuredClone(report.schema.canonical_positions),
        raw_values: structuredClone(row.raw_values), fields: structuredClone(row.fields), status: row.status,
      },
    };
  });
}
