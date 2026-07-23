/**
 * 出張距離測定・申請ガイド ─ アプリ配信＋経路検索API（Google Apps Script）
 * =====================================================================
 * Google Cloud の APIキー・課金設定は一切不要です。
 * GAS に内蔵されている Maps サービス（Maps.newDirectionFinder / newGeocoder）で
 * Google の高精度なルート・住所データを使います。
 *
 * このGASは2役を兼ねます：
 *   (1) パラメータなしでアクセス → アプリ本体(HTML)を配信（index.htmlを自動取得）
 *   (2) origin/dest や q を付けてアクセス → ルート/住所検索の結果をJSONで返す
 * これにより GitHub を使わず、すべて Google ドメイン（script.google.com）で完結し、
 * 学校など GitHub が開けない環境でも Google サイトに埋め込んで使えます。
 *
 * 【セットアップ手順】
 *   1. GitHubリポジトリを Public にする（GASがHTMLを読みに行くため）
 *   2. （前回の）GASプロジェクトを開き、このコードを貼り替えて保存
 *   3. 下の APP_HTML_URL が自分のリポジトリの raw URL になっているか確認
 *   4. デプロイ → デプロイを管理 → 鉛筆 → バージョン「新バージョン」→ デプロイ
 *      （初回は UrlFetch の権限を求められるので許可する）
 *   5. exec URL を開くと、アプリ画面が表示される（GASが index.html を取得して配信）
 *   6. （任意）Googleサイトに、その exec URL を iframe で埋め込む
 *
 * ※ 巨大HTMLを手で貼り付ける必要はありません。GASが自動取得します。
 *    index.html を更新すれば、最大10分ほどで配信内容も自動更新されます。
 *    page.html 内の GAS_API_URL は、この exec URL を指定しておくこと。
 *
 * 【リクエスト（GET クエリパラメータ）】
 *   origin        必須  "緯度,経度"            例: 34.781,135.452
 *   dest          必須  "緯度,経度"
 *   waypoints     任意  "緯度,経度|緯度,経度"  経由地（手動修正用）
 *   avoidHighways 任意  "1" で高速道路を回避
 *   avoidTolls    任意  "1" で有料道路を回避
 *   alternatives  任意  "1" で代替ルートも返す
 *   detectToll    任意  "1" で有料道路の有無を推定（avoidTolls=1 のときは無効）
 *
 * 【レスポンス（JSON）】
 *   成功: { ok:true,  routes:[ { distance, duration, polyline, summary, hasToll } ] }
 *           distance … 総距離（メートル）
 *           duration … 所要時間（秒）
 *           polyline … エンコード済みポリライン（Google精度5）
 *           hasToll  … 有料道路を含むと推定されるか（boolean）
 *   失敗: { ok:false, error:"..." }
 */

// アプリ本体(index.html)の raw URL。リポジトリ/ブランチが違う場合はここを直す。
// ※ この方式は GitHubリポジトリが Public である必要があります。
var APP_HTML_URL = 'https://raw.githubusercontent.com/edupower07/maps/main/index.html';

function doGet(e) {
  var p = (e && e.parameter) || {};

  // ── APIリクエスト（ルート検索 / 住所・施設検索）はJSONを返す ──
  if (p.origin || p.dest || p.q || p.mode) {
    try {
      // 住所・施設の検索（ジオコーディング）
      if (p.mode === 'geocode' || p.q) {
        return json_(geocode_(p.q));
      }

      var origin = parseLatLng_(p.origin);
      var dest   = parseLatLng_(p.dest);
      if (!origin || !dest) {
        throw new Error('origin / dest が不正です（"緯度,経度" 形式で指定してください）');
      }

      var avoidHighways = p.avoidHighways === '1';
      var avoidTolls    = p.avoidTolls === '1';
      var alternatives  = p.alternatives === '1';
      var detectToll    = p.detectToll === '1' && !avoidTolls;
      var waypoints     = parseWaypoints_(p.waypoints);

      var routes = findRoutes_(origin, dest, {
        avoidHighways: avoidHighways,
        avoidTolls: avoidTolls,
        alternatives: alternatives,
        waypoints: waypoints
      });

      // 有料道路の有無を推定（有料を許可しているモードのときだけ）。
      // 「有料回避ルート」の距離と比べ、現ルートが明確に短ければ有料利用とみなす。
      if (detectToll && routes.length) {
        var noTollDist = null;
        try {
          var noToll = findRoutes_(origin, dest, {
            avoidHighways: avoidHighways,
            avoidTolls: true,
            alternatives: false,
            waypoints: waypoints
          });
          if (noToll.length) noTollDist = noToll[0].distance;
        } catch (err) { /* 有料回避ルートが取れない場合は判定をスキップ */ }

        if (noTollDist != null) {
          routes.forEach(function (r) {
            r.hasToll = r.distance < noTollDist * 0.97; // 3%以上短ければ有料利用と推定
          });
        }
      }

      return json_({ ok: true, routes: routes });
    } catch (err) {
      return json_({ ok: false, error: String((err && err.message) || err) });
    }
  }

  // ── アプリ本体のHTMLを「テキスト」として返す（起動ページから読み込む用） ──
  // Apps Script に大きなHTMLを解釈させると document.write でエラーになるため、
  // HTMLは解釈させずテキストとして渡し、ブラウザ側で描画する。
  if (p.html === '1') {
    try {
      return ContentService.createTextOutput(fetchAppHtml_())
        .setMimeType(ContentService.MimeType.TEXT);
    } catch (err) {
      return ContentService.createTextOutput('<h2>取得失敗</h2><p>' + String((err && err.message) || err) + '</p>')
        .setMimeType(ContentService.MimeType.TEXT);
    }
  }

  // ── それ以外（パラメータなし）は、小さな「起動ページ」を配信する ──
  // 起動ページが上記 ?html=1 を取得して document.write で描画する。
  return bootstrapPage_();
}

// 小さな起動ページ。アプリ本体(HTML)をテキストで取得し、ブラウザ自身に描画させる。
// Apps Script の HTML 配信はこの小さなページだけなので壊れない。
function bootstrapPage_() {
  var self = ScriptApp.getService().getUrl();
  var boot =
    '<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1.0">' +
    '<style>html,body{margin:0;height:100%;font-family:sans-serif}#msg{padding:20px;color:#555}</style>' +
    '</head><body><div id="msg">読み込み中…</div>' +
    '<script>' +
    'fetch(' + JSON.stringify(self) + ' + "?html=1")' +
    '.then(function(r){return r.text();})' +
    '.then(function(t){document.open();document.write(t);document.close();})' +
    '.catch(function(e){document.getElementById("msg").textContent="読み込みに失敗しました: "+e;});' +
    '<\/script></body></html>';
  return HtmlService.createHtmlOutput(boot)
    .setTitle('出張距離測定・申請ガイド')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1.0');
}

// index.html をネット経由で取得（Googleのサーバーが代行）。10分間キャッシュ。
function fetchAppHtml_() {
  var cache = CacheService.getScriptCache();
  var key = 'app-html-v1';
  var cached = cache.get(key);
  if (cached) return cached;

  var res = UrlFetchApp.fetch(APP_HTML_URL, { muteHttpExceptions: true, followRedirects: true });
  var code = res.getResponseCode();
  if (code !== 200) {
    throw new Error('アプリHTMLの取得に失敗しました（HTTP ' + code + '）。リポジトリがPublicか、URLが正しいか確認してください。');
  }
  var html = res.getContentText('UTF-8');
  // CacheServiceは1項目100KBまで。超えるときはキャッシュせず毎回取得する。
  try { if (html.length < 100000) cache.put(key, html, 600); } catch (e) {}
  return html;
}

/**
 * DirectionFinder で経路を検索し、共通形式の配列にして返す。
 */
function findRoutes_(origin, dest, opt) {
  var finder = Maps.newDirectionFinder()
    .setOrigin(origin.lat, origin.lng)
    .setDestination(dest.lat, dest.lng)
    .setMode(Maps.DirectionFinder.Mode.DRIVING);

  if (opt.alternatives)  finder.setAlternatives(true);
  if (opt.avoidHighways) finder.setAvoid(Maps.DirectionFinder.Avoid.HIGHWAYS);
  if (opt.avoidTolls)    finder.setAvoid(Maps.DirectionFinder.Avoid.TOLLS);
  (opt.waypoints || []).forEach(function (w) { finder.addWaypoint(w.lat, w.lng); });

  var res = finder.getDirections();
  if (!res || res.status !== 'OK' || !res.routes || !res.routes.length) {
    throw new Error('ルートが見つかりません（status=' + (res && res.status) + '）');
  }

  return res.routes.map(function (route) {
    var distance = 0, duration = 0;
    (route.legs || []).forEach(function (leg) {
      distance += (leg.distance && leg.distance.value) || 0; // メートル
      duration += (leg.duration && leg.duration.value) || 0; // 秒
    });
    return {
      distance: distance,
      duration: duration,
      polyline: routePolyline_(route),
      summary: route.summary || '',
      hasToll: false
    };
  });
}

/**
 * ルートの形状ポリラインを返す。
 * overview_polyline は簡略化されていて頂点が粗く（直線部で数百m間隔）、
 * 地図表示のズレや重複区間の取りこぼしの原因になるため、
 * 各ステップの詳細ポリラインを連結した高解像度の線を優先して返す。
 */
function routePolyline_(route) {
  try {
    var pts = [];
    (route.legs || []).forEach(function (leg) {
      (leg.steps || []).forEach(function (st) {
        var enc = st.polyline && st.polyline.points;
        if (!enc) return;
        var dec = Maps.decodePolyline(enc); // [lat, lng, lat, lng, ...]
        var start = 0;
        // 接続点の重複を除いて連結
        if (pts.length >= 2 && dec.length >= 2 &&
            pts[pts.length - 2] === dec[0] && pts[pts.length - 1] === dec[1]) start = 2;
        for (var k = start; k < dec.length; k++) pts.push(dec[k]);
      });
    });
    if (pts.length >= 4) return Maps.encodePolyline(pts);
  } catch (e) { /* 失敗時は overview にフォールバック */ }
  return (route.overview_polyline && route.overview_polyline.points) || '';
}

/**
 * 住所・施設名を Google ジオコーダ（GAS内蔵・APIキー不要）で検索する。
 * 返り値: { ok:true, results:[ { name, addr, lat, lng, location_type, types, approx } ] }
 *   approx … 市区町村や都道府県の中心など「ざっくりした位置」かどうか
 * 注意: GASのMapsサービスはジオコーダ（住所中心）のみで、Places（施設名検索）は
 *       使えません。施設名は当たることもありますが、住所のほうが確実です。
 */
function geocode_(q) {
  q = (q || '').trim();
  if (!q) return { ok: false, error: 'q（検索語）を指定してください' };

  var geocoder = Maps.newGeocoder().setLanguage('ja').setRegion('jp');
  var res = geocoder.geocode(q);
  if (!res || (res.status !== 'OK' && res.status !== 'ZERO_RESULTS')) {
    return { ok: false, error: 'ジオコーディング失敗（status=' + (res && res.status) + '）' };
  }

  var results = (res.results || []).map(function (r) {
    var loc = r.geometry && r.geometry.location;
    var types = r.types || [];
    // 都道府県・市区町村レベルの「中心」しか出ていない＝施設・番地までは特定できていない
    var approx = (r.geometry && r.geometry.location_type === 'APPROXIMATE') &&
      types.some(function (t) {
        return t === 'locality' || t === 'political' || t === 'sublocality' ||
               t === 'administrative_area_level_1' || t === 'administrative_area_level_2';
      });
    return {
      name: r.formatted_address || '',
      addr: r.formatted_address || '',
      lat: loc ? loc.lat : null,
      lng: loc ? loc.lng : null,
      location_type: (r.geometry && r.geometry.location_type) || '',
      types: types,
      partial: !!r.partial_match,
      approx: approx
    };
  }).filter(function (r) { return r.lat != null && r.lng != null; });

  return { ok: true, results: results };
}

/** "緯度,経度" → {lat, lng}（不正なら null） */
function parseLatLng_(s) {
  if (!s) return null;
  var parts = String(s).split(',');
  if (parts.length < 2) return null;
  var lat = parseFloat(parts[0]), lng = parseFloat(parts[1]);
  if (isNaN(lat) || isNaN(lng)) return null;
  return { lat: lat, lng: lng };
}

/** "緯度,経度|緯度,経度" → [{lat,lng}, ...] */
function parseWaypoints_(s) {
  if (!s) return [];
  return String(s).split('|').map(parseLatLng_).filter(function (v) { return v; });
}

/** オブジェクトを JSON レスポンスにする */
function json_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
