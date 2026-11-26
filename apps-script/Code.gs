/**
 * Revisión de pedidos OXS - Google Apps Script
 *
 * Dos modalidades en la misma app:
 *   1. Pedidos de clientes: revisa una factura, boleta o nota de venta de Bsale por folio.
 *   2. Bodega: revisa un pedido de la hoja "EN CURSO BODEGA" y, al cerrar,
 *      emite la guía de despacho en Bsale y envía el PDF por correo.
 *
 * Propiedades del script (Configuración del proyecto > Propiedades del script):
 *   BSALE_TOKEN            token de la API de Bsale (obligatorio)
 *   MODO_BODEGA            PRUEBA (por defecto) o PRODUCCION
 *                          PRUEBA: no emite guía; deja un borrador de correo con el resumen.
 *                          PRODUCCION: emite la guía en Bsale y envía el correo con el PDF.
 *   CORREOS_BODEGA         correos separados por coma que reciben la guía
 *   GUIA_DOCUMENT_TYPE_ID  id del tipo de documento "Guía de despacho" en Bsale
 *   GUIA_OFFICE_ID         id de la sucursal que emite la guía (Bodega)
 *   GUIA_SHIPPING_TYPE_ID  id del tipo de despacho (por ejemplo, traslado interno)
 *   GUIA_DIRECCION         por defecto: Compañía 4445
 *   GUIA_COMUNA            por defecto: Quinta Normal
 *   GUIA_CIUDAD            por defecto: Santiago
 *   GUIA_DESTINATARIO      por defecto: OXS Compañía
 *   ANTHROPIC_API_KEY      clave de la API de Claude para contar cajas en las fotos de pallets
 *   MODELO_IA              (opcional) por defecto: claude-sonnet-5-5
 *   CLAVE_APP              clave que ingresan los revisores en la app de GitHub Pages (obligatoria para usarla)
 *   REGISTRO_SHEET_ID      (automático) planilla "Registro revisiones de pedidos OXS"; se crea sola la primera vez
 *   CARPETA_FOTOS_ID       (opcional) id de la carpeta de Drive para las fotos de pallets.
 *                          Si no se indica, se crea "Revisión bodega OXS - fotos" en Mi unidad.
 *
 * Para encontrar los ids de Bsale, ejecuta verConfiguracionBsale() y revisa el registro.
 */

const BSALE_API = 'https://api.bsale.io/v1';
const PEDIDOS_SHEET_ID = '119A48FvSaVZEETaKmamPBqxuR0lidnyyccjKooEOxV0'; // LISTADO PEDIDOS OXS 2026
const PEDIDOS_HOJA = 'EN CURSO BODEGA';
const PALABRAS_NO_FISICAS = /despacho|env[ií]o|flete|transporte|servicio|instalaci[oó]n/i;

/* ---------------------------------------------------------------- web app */

function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('Revisión de pedidos OXS')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, maximum-scale=1');
}

/**
 * Punto de acceso para la pantalla alojada en GitHub Pages.
 * Recibe { clave, fn, args } como texto JSON y responde { ok, data } o { ok: false, error }.
 */
function doPost(e) {
  let respuesta;
  try {
    const req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    const clave = prop_('CLAVE_APP', '');
    if (!clave) throw new Error('Falta configurar CLAVE_APP en las propiedades del script.');
    if (req.clave !== clave) throw new Error('Clave de acceso incorrecta.');
    const permitidas = {
      verificarClave: function () { return true; },
      buscarDocumento: buscarDocumento,
      listarPedidosBodega: listarPedidosBodega,
      cargarPedidoBodega: cargarPedidoBodega,
      subirFotoPallet: subirFotoPallet,
      registrarRevision: registrarRevision,
      cerrarRevisionBodega: cerrarRevisionBodega
    };
    const fn = permitidas[req.fn];
    if (!fn) throw new Error('Acción no permitida.');
    respuesta = { ok: true, data: fn.apply(null, req.args || []) };
  } catch (err) {
    respuesta = { ok: false, error: err && err.message ? err.message : String(err) };
  }
  return ContentService.createTextOutput(JSON.stringify(respuesta)).setMimeType(ContentService.MimeType.JSON);
}

/* ---------------------------------------------------------------- utilidades */

function prop_(clave, porDefecto) {
  const v = PropertiesService.getScriptProperties().getProperty(clave);
  return (v === null || v === '') ? porDefecto : v;
}

function token_() {
  const t = prop_('BSALE_TOKEN', '');
  if (!t) throw new Error('Falta configurar BSALE_TOKEN en las propiedades del script.');
  return t;
}

function url_(ruta) { return ruta.indexOf('http') === 0 ? ruta : BSALE_API + ruta; }

function get_(ruta) {
  const r = UrlFetchApp.fetch(url_(ruta), { headers: { access_token: token_() }, muteHttpExceptions: true });
  if (r.getResponseCode() !== 200) {
    throw new Error('Bsale respondió ' + r.getResponseCode() + ': ' + r.getContentText().slice(0, 300));
  }
  return JSON.parse(r.getContentText());
}

function post_(ruta, cuerpo) {
  const r = UrlFetchApp.fetch(url_(ruta), {
    method: 'post',
    contentType: 'application/json',
    headers: { access_token: token_() },
    payload: JSON.stringify(cuerpo),
    muteHttpExceptions: true
  });
  const code = r.getResponseCode();
  if (code !== 200 && code !== 201) {
    throw new Error('Bsale rechazó la guía (' + code + '): ' + r.getContentText().slice(0, 400));
  }
  return JSON.parse(r.getContentText());
}

function getMuchos_(rutas) {
  if (!rutas.length) return [];
  const t = token_();
  const resp = UrlFetchApp.fetchAll(rutas.map(function (ruta) {
    return { url: url_(ruta), headers: { access_token: t }, muteHttpExceptions: true };
  }));
  return resp.map(function (r) { return r.getResponseCode() === 200 ? JSON.parse(r.getContentText()) : null; });
}

function todasLasPaginas_(ruta) {
  const items = [];
  let siguiente = ruta, vueltas = 0;
  while (siguiente && vueltas < 50) {
    const data = get_(siguiente);
    (data.items || []).forEach(function (i) { items.push(i); });
    siguiente = data.next || null;
    vueltas++;
  }
  return items;
}

function infoVariante_(v) {
  const p = v.product || {};
  return {
    variantId: v.id,
    nombre: p.name || v.description || '',
    variante: v.description || '',
    sku: v.code || '',
    barcode: v.barCode || '',
    servicio: p.classification === 1
  };
}

function ordenar_(items) {
  items.sort(function (a, b) {
    return (a.nombre + ' ' + a.variante).localeCompare(b.nombre + ' ' + b.variante, 'es', { sensitivity: 'base' });
  });
  return items;
}

/* ---------------------------------------------------------------- modalidad 1: factura o boleta */

function buscarDocumento(folio, tipo) {
  folio = String(folio || '').trim();
  tipo = String(tipo || 'FACTURA').toUpperCase();
  if (!/^\d+$/.test(folio)) throw new Error('El folio debe ser solo números.');

  const docs = todasLasPaginas_('/documents.json?number=' + folio + '&limit=50&expand=[document_type,client]');
  const candidatos = docs.filter(function (d) {
    d._tipoNombre = nombreTipo_(d);
    return d.state === 0 && normTipo_(d._tipoNombre).indexOf(normTipo_(tipo)) !== -1 && !/NOTA DE CR|NOTA DE D|GU[IÍ]A|COTIZ/i.test(d._tipoNombre);
  });
  if (!candidatos.length) throw new Error('No se encontró una ' + tipo.toLowerCase() + ' activa con folio ' + folio + ' en Bsale.');
  candidatos.sort(function (a, b) { return (b.emissionDate || 0) - (a.emissionDate || 0); });
  const doc = candidatos[0];

  const detalles = todasLasPaginas_('/documents/' + doc.id + '/details.json?limit=100');
  const porVariante = {};
  const ocultas = [];
  detalles.forEach(function (d) {
    const vId = d.variant && d.variant.id;
    if (!vId) { ocultas.push(d.note || 'Línea sin producto'); return; }
    porVariante[vId] = (porVariante[vId] || 0) + Number(d.quantity || 0);
  });

  const variantes = variantesPorId_(Object.keys(porVariante));
  const items = [];
  Object.keys(porVariante).forEach(function (id) {
    const v = variantes[id];
    const nombre = v ? v.nombre : 'Variante ' + id;
    if (!v || v.servicio || PALABRAS_NO_FISICAS.test(nombre)) { ocultas.push(nombre); return; }
    items.push({ key: 'v' + id, variantId: Number(id), nombre: v.nombre, variante: v.variante, sku: v.sku, barcode: v.barcode, cantidad: porVariante[id] });
  });

  return {
    modo: 'documento',
    id: 'doc_' + doc.id,
    titulo: (doc._tipoNombre || tipo) + ' ' + doc.number,
    subtitulo: [nombreCliente_(doc.client), doc.emissionDate ? 'Emitida el ' + fecha_(doc.emissionDate) : ''].filter(String).join('\n'),
    items: ordenar_(items),
    ocultas: ocultas
  };
}

/** Normaliza nombres de tipo: "Nota de venta" y "NOTA VENTA" quedan iguales. */
function normTipo_(s) {
  return String(s || '').toUpperCase().replace(/ DE /g, ' ').replace(/\s+/g, ' ').trim();
}

function nombreTipo_(doc) {
  const dt = doc.document_type;
  if (dt && dt.name) return dt.name;
  if (dt && dt.href) { try { return get_(dt.href).name || ''; } catch (e) { return ''; } }
  return '';
}

function nombreCliente_(c) {
  if (!c) return '';
  if (c.company) return c.company;
  return [c.firstName, c.lastName].filter(String).join(' ');
}

function fecha_(unix) {
  return Utilities.formatDate(new Date(unix * 1000), 'UTC', 'dd-MM-yyyy');
}

function variantesPorId_(ids) {
  const cache = CacheService.getScriptCache();
  const enCache = cache.getAll(ids.map(function (id) { return 'var_' + id; }));
  const resultado = {}, faltan = [];
  ids.forEach(function (id) { const c = enCache['var_' + id]; if (c) resultado[id] = JSON.parse(c); else faltan.push(id); });
  for (let i = 0; i < faltan.length; i += 20) {
    const lote = faltan.slice(i, i + 20);
    const resp = getMuchos_(lote.map(function (id) { return '/variants/' + id + '.json?expand=[product]'; }));
    const guardar = {};
    resp.forEach(function (v, k) {
      if (!v) return;
      const info = infoVariante_(v);
      resultado[lote[k]] = info;
      guardar['var_' + lote[k]] = JSON.stringify(info);
    });
    if (Object.keys(guardar).length) cache.putAll(guardar, 21600);
  }
  return resultado;
}

/* ---------------------------------------------------------------- modalidad 2: bodega */

function hojaPedidos_() {
  const ss = SpreadsheetApp.openById(PEDIDOS_SHEET_ID);
  const hoja = ss.getSheets().filter(function (h) { return h.getName().trim().toUpperCase() === PEDIDOS_HOJA; })[0];
  if (!hoja) throw new Error('No se encontró la pestaña "' + PEDIDOS_HOJA + '" en LISTADO PEDIDOS OXS 2026.');
  return hoja;
}

/** Detecta los bloques de pedido dentro de la hoja. */
function leerBloques_() {
  const valores = hojaPedidos_().getDataRange().getDisplayValues();
  const bloques = [];
  const limpio = function (s) { return String(s || '').trim(); };

  for (let r = 0; r < valores.length; r++) {
    const fila = valores[r];
    const colSku = fila.findIndex(function (c) { return /^sku$/i.test(limpio(c)); });
    if (colSku === -1) continue;

    const busca = function (re) { return fila.findIndex(function (c) { return re.test(limpio(c)); }); };
    const colProd = busca(/^producto/i);
    const colVar = busca(/^(talla|variante)/i);
    const colCant = busca(/cantidad/i);
    if (colCant === -1) continue;

    // Título: la fila con texto más cercana sobre el encabezado (hasta 4 filas arriba)
    let titulo = '';
    for (let k = r - 1; k >= Math.max(0, r - 4) && !titulo; k--) {
      const t = valores[k].map(limpio).filter(String);
      if (t.length === 1) titulo = t[0];
    }

    const lineas = [];
    let k = r + 1;
    for (; k < valores.length; k++) {
      const f = valores[k];
      const sku = limpio(f[colSku]);
      if (!sku) break;
      if (/^sku$/i.test(sku)) break;
      lineas.push({
        producto: colProd >= 0 ? limpio(f[colProd]) : '',
        talla: colVar >= 0 ? limpio(f[colVar]) : '',
        sku: sku,
        cantidad: Number(String(f[colCant]).replace(/\./g, '').replace(',', '.')) || 0
      });
    }
    bloques.push({
      id: 'bod_' + (r + 1),
      fila: r + 1,
      titulo: titulo || 'Pedido sin título (fila ' + (r + 1) + ')',
      lineas: lineas
    });
    r = k - 1;
  }
  return bloques;
}

/** Lista de pedidos disponibles para revisar en bodega. */
function listarPedidosBodega() {
  return leerBloques_().map(function (b) {
    return {
      id: b.id,
      titulo: b.titulo,
      productos: b.lineas.length,
      unidades: b.lineas.reduce(function (s, l) { return s + l.cantidad; }, 0)
    };
  });
}

/** Carga un pedido de bodega y completa código de barras e id de variante desde Bsale. */
function cargarPedidoBodega(id) {
  const bloque = leerBloques_().filter(function (b) { return b.id === id; })[0];
  if (!bloque) throw new Error('El pedido ya no está en la hoja o cambió de posición. Vuelve a cargar la lista.');

  const porSku = {};
  bloque.lineas.forEach(function (l) {
    if (!porSku[l.sku]) porSku[l.sku] = { producto: l.producto, talla: l.talla, cantidad: 0 };
    porSku[l.sku].cantidad += l.cantidad;
  });

  const skus = Object.keys(porSku);
  const variantes = variantesPorSku_(skus);
  const items = skus.map(function (sku) {
    const l = porSku[sku], v = variantes[sku];
    return {
      key: 's' + sku,
      variantId: v ? v.variantId : null,
      nombre: l.producto || (v && v.nombre) || sku,
      variante: l.talla || (v && v.variante) || '',
      sku: sku,
      barcode: v ? v.barcode : '',
      cantidad: l.cantidad,
      embalaje: embalaje_(l.producto),
      noEnBsale: !v
    };
  });

  return {
    modo: 'bodega',
    id: bloque.id + '_' + Utilities.base64EncodeWebSafe(bloque.titulo).slice(0, 12),
    pedidoId: bloque.id,
    titulo: bloque.titulo,
    subtitulo: 'Pedido a bodega VLG\n' + skus.length + ' productos',
    items: ordenar_(items),
    ocultas: []
  };
}

/** Unidades por caja según el número entre paréntesis al final del nombre, por ejemplo "(6)". */
function embalaje_(nombre) {
  const m = String(nombre || '').match(/\((\d+)\)\s*$/) || String(nombre || '').match(/\((\d+)\)(?!.*\(\d+\))/);
  const n = m ? Number(m[1]) : 0;
  return n > 0 ? n : 1;
}

function variantesPorSku_(skus) {
  const cache = CacheService.getScriptCache();
  const enCache = cache.getAll(skus.map(function (s) { return 'sku_' + s; }));
  const resultado = {}, faltan = [];
  skus.forEach(function (s) { const c = enCache['sku_' + s]; if (c) resultado[s] = JSON.parse(c); else faltan.push(s); });
  for (let i = 0; i < faltan.length; i += 20) {
    const lote = faltan.slice(i, i + 20);
    const resp = getMuchos_(lote.map(function (s) { return '/variants.json?code=' + encodeURIComponent(s) + '&expand=[product]'; }));
    const guardar = {};
    resp.forEach(function (data, k) {
      const v = data && data.items && data.items.filter(function (x) { return x.state === 0; })[0] || (data && data.items && data.items[0]);
      if (!v) return;
      const info = infoVariante_(v);
      resultado[lote[k]] = info;
      guardar['sku_' + lote[k]] = JSON.stringify(info);
    });
    if (Object.keys(guardar).length) cache.putAll(guardar, 21600);
  }
  return resultado;
}

/** Carpeta de Drive para las fotos de un pedido (una subcarpeta por pedido y día). */
function carpetaPedido_(titulo) {
  let raiz;
  const id = prop_('CARPETA_FOTOS_ID', '');
  if (id) raiz = DriveApp.getFolderById(id);
  else {
    const it = DriveApp.getRootFolder().getFoldersByName('Revisión bodega OXS - fotos');
    raiz = it.hasNext() ? it.next() : DriveApp.getRootFolder().createFolder('Revisión bodega OXS - fotos');
    PropertiesService.getScriptProperties().setProperty('CARPETA_FOTOS_ID', raiz.getId());
  }
  const nombre = Utilities.formatDate(new Date(), 'America/Santiago', 'yyyy-MM-dd') + ' ' + String(titulo).slice(0, 80);
  const sub = raiz.getFoldersByName(nombre);
  return sub.hasNext() ? sub.next() : raiz.createFolder(nombre);
}

/** Recibe la foto de un pallet (data URL JPEG) y la guarda en Drive. */
function subirFotoPallet(titulo, pallet, dataUrl) {
  const partes = String(dataUrl || '').split(',');
  if (partes.length < 2) throw new Error('La foto llegó vacía. Vuelve a tomarla.');
  const hora = Utilities.formatDate(new Date(), 'America/Santiago', 'HHmmss');
  const blob = Utilities.newBlob(Utilities.base64Decode(partes[1]), 'image/jpeg', 'Pallet_' + pallet + '_' + hora + '.jpg');
  const archivo = carpetaPedido_(titulo).createFile(blob);
  let conteo = null, errorIa = '';
  try { conteo = contarCajas_(partes[1]); } catch (e) { errorIa = e.message; }
  return { id: archivo.getId(), url: archivo.getUrl(), nombre: archivo.getName(), conteo: conteo, errorIa: errorIa };
}

/** Pide a Claude que cuente las cajas visibles en la foto del pallet. */
function contarCajas_(base64) {
  const clave = prop_('ANTHROPIC_API_KEY', '');
  if (!clave) throw new Error('Falta ANTHROPIC_API_KEY para contar cajas con IA');
  const instruccion =
    'Eres un asistente de bodega. La foto muestra un pallet de cajas de cartón armado de modo que todas las cajas ' +
    'miran hacia la cámara. Cuenta cuántas cajas distintas se ven. Cuenta cada caja una sola vez, aunque tenga varias etiquetas. ' +
    'No cuentes el pallet de madera, film, papeles sueltos ni cajas que no estén sobre este pallet. ' +
    'Si hay partes tapadas o dudosas, dilo en la nota. Responde solo con JSON, sin texto adicional: ' +
    '{"cajas": numero_entero, "confianza": "alta" | "media" | "baja", "nota": "frase corta en español"}';
  const r = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'post',
    contentType: 'application/json',
    headers: { 'x-api-key': clave, 'anthropic-version': '2023-06-01' },
    payload: JSON.stringify({
      model: prop_('MODELO_IA', 'claude-sonnet-5-5'),
      max_tokens: 300,
      messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: base64 } },
        { type: 'text', text: instruccion }
      ] }]
    }),
    muteHttpExceptions: true
  });
  if (r.getResponseCode() !== 200) throw new Error('La IA respondió ' + r.getResponseCode() + ': ' + r.getContentText().slice(0, 200));
  const texto = (JSON.parse(r.getContentText()).content || []).map(function (c) { return c.text || ''; }).join('');
  const json = texto.slice(texto.indexOf('{'), texto.lastIndexOf('}') + 1);
  const d = JSON.parse(json);
  return { cajas: Math.max(0, Math.round(Number(d.cajas) || 0)), confianza: d.confianza || '', nota: d.nota || '' };
}

/**
 * Cierra una revisión de bodega.
 * conteos: [{ sku, variantId, nombre, variante, pedida, revisada }]
 * resumen: texto con el resultado y las diferencias
 * pallets: [{ n, fotoId, bultos, cajasFoto, cajasFotoManual, items:[{ nombre, variante, sku, cantidad }] }]
 */
function cerrarRevisionBodega(titulo, conteos, resumen, pallets) {
  pallets = pallets || [];
  const textoPallets = pallets.length ? '\n\nDetalle por pallet:\n' + pallets.map(function (p) {
    const u = p.items.reduce(function (s, i) { return s + i.cantidad; }, 0);
    const cajas = p.bultos != null ? p.bultos + ' bultos escaneados' : '';
    const ia = p.cajasFoto != null ? ', ' + p.cajasFoto + ' cajas en la foto' + (p.cajasFotoManual ? ' (corregido a mano)' : ' (conteo IA)') : '';
    return 'Pallet ' + p.n + ' (' + cajas + ia + ', ' + u + ' unidades' + (p.fotoId ? ', foto adjunta' : ', sin foto') + ')\n' +
      p.items.map(function (i) { return '  - ' + i.nombre + (i.variante ? ' / ' + i.variante : '') + ' (SKU ' + i.sku + '): ' + i.cantidad; }).join('\n');
  }).join('\n\n') : '';
  const totalBultos = pallets.reduce(function (s, p) { return s + (p.bultos || 0); }, 0);
  if (pallets.length) resumen += '\nPallets: ' + pallets.length + '. Bultos totales: ' + totalBultos + '.';
  const fotos = [];
  pallets.forEach(function (p) {
    if (!p.fotoId) return;
    try { fotos.push(DriveApp.getFileById(p.fotoId).getBlob().setName('Pallet_' + p.n + '.jpg')); } catch (e) {}
  });

  const modo = String(prop_('MODO_BODEGA', 'PRUEBA')).toUpperCase();
  const correos = String(prop_('CORREOS_BODEGA', '')).split(',').map(function (s) { return s.trim(); }).filter(String);
  if (!correos.length) throw new Error('Falta configurar CORREOS_BODEGA en las propiedades del script.');

  const lineas = conteos.filter(function (c) { return c.revisada > 0; });
  const sinVariante = lineas.filter(function (c) { return !c.variantId; });
  if (!lineas.length) throw new Error('No hay unidades revisadas para incluir en la guía.');

  const cuerpoGuia = {
    documentTypeId: Number(prop_('GUIA_DOCUMENT_TYPE_ID', 0)),
    officeId: Number(prop_('GUIA_OFFICE_ID', 0)),
    shippingTypeId: Number(prop_('GUIA_SHIPPING_TYPE_ID', 0)),
    emissionDate: hoyUnix_(),
    declareSii: 1,
    recipient: prop_('GUIA_DESTINATARIO', 'OXS Compañía'),
    address: prop_('GUIA_DIRECCION', 'Compañía 4445'),
    municipality: prop_('GUIA_COMUNA', 'Quinta Normal'),
    city: prop_('GUIA_CIUDAD', 'Santiago'),
    details: lineas.filter(function (c) { return c.variantId; }).map(function (c) {
      return { variantId: c.variantId, quantity: c.revisada, netUnitValue: 0 };
    })
  };

  const asuntoBase = 'Guía de despacho - ' + titulo;
  const detalleTexto = lineas.map(function (c) {
    return '- ' + c.nombre + (c.variante ? ' / ' + c.variante : '') + ' (SKU ' + c.sku + '): ' + c.revisada;
  }).join('\n');
  const avisoSinVariante = sinVariante.length
    ? '\n\nNo se incluyeron en la guía porque el SKU no existe en Bsale:\n' + sinVariante.map(function (c) { return '- SKU ' + c.sku + ' (' + c.revisada + ')'; }).join('\n')
    : '';

  if (modo !== 'PRODUCCION') {
    const cuerpo = 'MODO PRUEBA: no se emitió guía en Bsale.\n\n' + resumen +
      '\n\nUnidades que irían en la guía:\n' + detalleTexto + avisoSinVariante + textoPallets +
      '\n\nDatos de la guía que se enviarían a Bsale:\n' + JSON.stringify(cuerpoGuia, null, 2);
    GmailApp.createDraft(correos.join(','), '[PRUEBA] ' + asuntoBase, cuerpo, { attachments: fotos });
    return { modo: 'PRUEBA', mensaje: 'Modo prueba: no se emitió la guía. Quedó un borrador de correo con el resumen en la cuenta que publicó la app.' };
  }

  ['documentTypeId', 'officeId', 'shippingTypeId'].forEach(function (k) {
    if (!cuerpoGuia[k]) throw new Error('Falta configurar el id de Bsale para ' + k + '. Ejecuta verConfiguracionBsale().');
  });

  const resp = post_('/shippings.json', cuerpoGuia);
  let guia = resp;
  if (resp.guide && resp.guide.href) guia = get_(resp.guide.href);
  const numero = guia.number || resp.number || '';
  const urlPdf = guia.urlPdf || resp.urlPdf || '';

  const adjuntos = [];
  const adjuntosFotos = fotos;
  if (urlPdf) {
    try { adjuntos.push(UrlFetchApp.fetch(urlPdf).getBlob().setName('Guia_despacho_' + numero + '.pdf')); } catch (e) {}
  }
  const cuerpo = 'Hola,\n\nAdjuntamos la guía de despacho N° ' + numero + ' del ' + titulo + '.\n\n' + resumen +
    '\n\nDetalle despachado:\n' + detalleTexto + avisoSinVariante + textoPallets +
    (urlPdf && !adjuntos.length ? '\n\nPDF: ' + urlPdf : '') + '\n\nSaludos,\nOXS';
  GmailApp.sendEmail(correos.join(','), asuntoBase + ' (N° ' + numero + ')', cuerpo, { attachments: adjuntos.concat(adjuntosFotos) });

  return { modo: 'PRODUCCION', numero: numero, urlPdf: urlPdf, mensaje: 'Guía N° ' + numero + ' emitida y enviada a ' + correos.length + ' correos.' };
}

/* ---------------------------------------------------------------- registro de revisiones */

const ENCABEZADOS_REGISTRO = ['ID revisión', 'Modo', 'Documento', 'Cliente / detalle', 'Revisor', 'Inicio', 'Término', 'Estado',
  'Unidades pedidas', 'Unidades revisadas', 'Faltantes', 'Sobrantes', 'Fuera del documento', 'Incidencias', 'Detalle de diferencias', 'Actualizado'];

function hojaRegistro_() {
  let ss = null;
  const id = prop_('REGISTRO_SHEET_ID', '');
  if (id) { try { ss = SpreadsheetApp.openById(id); } catch (e) { ss = null; } }
  if (!ss) {
    ss = SpreadsheetApp.create('Registro revisiones de pedidos OXS');
    ss.setSpreadsheetTimeZone('America/Santiago');
    PropertiesService.getScriptProperties().setProperty('REGISTRO_SHEET_ID', ss.getId());
  }
  let h = ss.getSheetByName('Revisiones');
  if (!h) {
    h = ss.getSheets()[0];
    h.setName('Revisiones');
  }
  if (h.getLastRow() === 0) {
    h.appendRow(ENCABEZADOS_REGISTRO);
    h.setFrozenRows(1);
    h.getRange(1, 1, 1, ENCABEZADOS_REGISTRO.length).setFontWeight('bold');
    h.getRange('F:G').setNumberFormat('dd-mm-yyyy hh:mm:ss');
    h.getRange('P:P').setNumberFormat('dd-mm-yyyy hh:mm:ss');
  }
  return h;
}

/**
 * Crea o actualiza la fila de una revisión.
 * r: { id, modo, documento, cliente, revisor, inicio, termino, estado, pedidas, revisadas, faltantes, sobrantes, fuera, incidencias, detalle }
 * inicio y termino en milisegundos.
 */
function registrarRevision(r) {
  r = r || {};
  if (!r.id) throw new Error('Falta el ID de la revisión.');
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const h = hojaRegistro_();
    const fila = [
      String(r.id), r.modo || '', r.documento || '', r.cliente || '', r.revisor || '',
      r.inicio ? new Date(Number(r.inicio)) : '', r.termino ? new Date(Number(r.termino)) : '',
      r.estado || '', Number(r.pedidas) || 0, Number(r.revisadas) || 0, Number(r.faltantes) || 0,
      Number(r.sobrantes) || 0, Number(r.fuera) || 0, Number(r.incidencias) || 0,
      String(r.detalle || '').slice(0, 45000), new Date()
    ];
    const n = h.getLastRow() - 1;
    const ids = n > 0 ? h.getRange(2, 1, n, 1).getValues().map(function (x) { return String(x[0]); }) : [];
    const i = ids.indexOf(String(r.id));
    if (i >= 0) h.getRange(i + 2, 1, 1, fila.length).setValues([fila]);
    else h.appendRow(fila);
    return { url: h.getParent().getUrl() };
  } finally {
    lock.releaseLock();
  }
}

function hoyUnix_() {
  const hoy = Utilities.formatDate(new Date(), 'America/Santiago', 'yyyy-MM-dd').split('-').map(Number);
  return Math.floor(Date.UTC(hoy[0], hoy[1] - 1, hoy[2]) / 1000);
}

/* ---------------------------------------------------------------- pruebas y configuración */

/** Ejecuta desde el editor para revisar la factura de prueba. */
function probarFactura21735() {
  Logger.log(JSON.stringify(buscarDocumento('21735', 'FACTURA'), null, 2));
}

/** Prueba con la nota de venta 27576 (2 productos, 1 unidad de cada uno). */
function probarNotaVenta27576() {
  Logger.log(JSON.stringify(buscarDocumento('27576', 'NOTA VENTA'), null, 2));
}

/** Ejecuta desde el editor para ver los pedidos que detecta en la hoja de bodega. */
function probarPedidosBodega() {
  Logger.log(JSON.stringify(listarPedidosBodega(), null, 2));
}

/** Muestra los ids de Bsale necesarios para la guía de despacho. */
function verConfiguracionBsale() {
  const tipos = todasLasPaginas_('/document_types.json?limit=50&state=0')
    .filter(function (t) { return /GU[IÍ]A/i.test(t.name); })
    .map(function (t) { return t.id + ' - ' + t.name; });
  const sucursales = todasLasPaginas_('/offices.json?limit=50&state=0').map(function (o) { return o.id + ' - ' + o.name; });
  let traslados = [];
  try { traslados = todasLasPaginas_('/shipping_types.json?limit=50').map(function (s) { return s.id + ' - ' + s.name; }); } catch (e) { traslados = ['No disponible: ' + e.message]; }
  Logger.log('GUIA_DOCUMENT_TYPE_ID (tipos de guía):\n' + tipos.join('\n'));
  Logger.log('GUIA_OFFICE_ID (sucursales):\n' + sucursales.join('\n'));
  Logger.log('GUIA_SHIPPING_TYPE_ID (tipos de despacho):\n' + traslados.join('\n'));
}
