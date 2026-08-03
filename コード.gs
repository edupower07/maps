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
 *   （有料道路の有無は Google の警告情報 warnings から自動判定します）
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

/* ============================================================
 *  利用制限（アクセス制御）の設定
 * ============================================================
 * URLが無制限に広がるのを防ぐため、「Googleアカウントのメールアドレス」で
 * 利用者を制限できます。許可の判定は次の順で行います。
 *   ① ADMIN_EMAILS に入っている        → 許可
 *   ② ALLOWED_DOMAINS のドメイン       → 許可（例：市のGoogle Workspaceドメイン）
 *   ③ 申請フォームの回答シートに載っている → 許可（自動。手作業の追加は不要）
 * どれにも当てはまらない人には「利用申請はこちら」の案内を表示します。
 *
 * 【使い始めるまでの手順】
 *   1. Googleフォームを作る（メールアドレスを収集する設定にする）
 *   2. フォームの回答をスプレッドシートに保存し、そのURLの
 *      /d/【ここがID】/edit の部分を ALLOWLIST_SHEET_ID に貼る
 *   3. APPLY_FORM_URL にフォームの公開URLを貼る
 *   4. ACCESS_CONTROL_ENABLED を true にする
 *   5. 「デプロイ → デプロイを管理 → 鉛筆 → 新バージョン」で再デプロイ
 * ※ 設定が空のまま true にすると誰も使えなくなるので、設定後に true にすること。
 *
 * 【重要：GASプロジェクトの所有者について】
 * 利用者のメールアドレスを取得できるのは、次のどちらかの場合だけです。
 *   ・GASの所有者と利用者が「同じドメイン」のアカウント（推奨）
 *   ・デプロイの実行ユーザーを「ウェブアプリにアクセスしているユーザー」にした場合
 * 個人のGmailアカウントでGASを作っていると、学校ドメイン(例 kita9.ed.jp)の
 * 利用者のアドレスが取得できず、全員が「未登録」になってしまいます。
 * その場合は、学校ドメインのアカウントでGASプロジェクトを作り直してください。
 * 有効にする前に、必ず「?whoami=1」を職員のアカウントで開いて確認すること。
 */
var ACCESS_CONTROL_ENABLED = true;    // false にすると誰でも使える（制限なし）

// 管理者（常に利用可）。※このファイルはGitHubで公開されるため、
// 個人のメールアドレスはここに直接書かず、GASの
// 「プロジェクトの設定 → スクリプト プロパティ」に
// キー ADMIN_EMAILS ／ 値 メールアドレス（カンマ区切り）で登録してください。
var ADMIN_EMAILS = [];

var ALLOWED_DOMAINS = [               // このドメインのアカウントは申請不要で許可
  'kita9.ed.jp'                       // 北九州市の学校アカウント
];

// フォーム回答スプレッドシートのID。ドメイン許可だけで足りる場合は空のままでOK。
// （スクリプト プロパティに ALLOWLIST_SHEET_ID を登録しても指定できます）
var ALLOWLIST_SHEET_ID = '';
var ALLOWLIST_SHEET_NAME = '';        // シート名（空なら先頭のシート）
var ALLOWLIST_EMAIL_HEADER = 'メールアドレス';  // メールアドレスの列名（自動検出もします）
var ALLOWLIST_APPROVED_HEADER = '';   // 空＝申請したら即利用可。列名を書くと、その列が
                                      // TRUE/○/承認 の行だけ許可（管理者が承認する運用）
var APPLY_FORM_URL = '';              // 利用申請フォームのURL（案内画面に表示）
var ALLOWLIST_CACHE_SEC = 300;        // 許可リストの再読み込み間隔（秒）

// ===== 利用者の確認 =====

// いまアクセスしている人のメールアドレス（取得できないときは空文字）
function currentUserEmail_() {
  try { return String(Session.getActiveUser().getEmail() || '').trim().toLowerCase(); }
  catch (e) { return ''; }
}

// 利用してよい人かどうかを判定する
function checkAccess_() {
  if (!ACCESS_CONTROL_ENABLED) return { ok: true, email: currentUserEmail_() };

  var email = currentUserEmail_();
  if (!email) {
    return { ok: false, email: '', reason: 'no-identity',
             message: 'Googleアカウントが確認できませんでした。学校のGoogleアカウントでログインした状態で開いてください。' };
  }
  if (configList_(ADMIN_EMAILS, 'ADMIN_EMAILS').indexOf(email) !== -1) return { ok: true, email: email };

  var domain = email.split('@')[1] || '';
  if (configList_(ALLOWED_DOMAINS, 'ALLOWED_DOMAINS').indexOf(domain) !== -1) return { ok: true, email: email };

  if (loadAllowlist_().indexOf(email) !== -1) return { ok: true, email: email };

  return { ok: false, email: email, reason: 'not-listed',
           message: 'このアカウントはまだ利用登録されていません。' };
}

function lower_(s) { return String(s || '').trim().toLowerCase(); }

// 設定値を「コード内の値」＋「スクリプト プロパティの値（カンマ区切り）」から作る。
// 個人のメールアドレスなどを公開リポジトリに書かずに済むようにするための仕組み。
function configList_(inCode, propKey) {
  var list = (inCode || []).map(lower_);
  try {
    var raw = PropertiesService.getScriptProperties().getProperty(propKey);
    if (raw) raw.split(',').forEach(function (v) { v = lower_(v); if (v) list.push(v); });
  } catch (e) {}
  return list;
}

// 許可リストのスプレッドシートID（スクリプト プロパティ優先）
function allowlistSheetId_() {
  try {
    var v = PropertiesService.getScriptProperties().getProperty('ALLOWLIST_SHEET_ID');
    if (v) return String(v).trim();
  } catch (e) {}
  return ALLOWLIST_SHEET_ID;
}

// 申請フォームの回答シートから、許可するメールアドレスの一覧を読み込む（一定時間キャッシュ）
function loadAllowlist_() {
  var cache = CacheService.getScriptCache();
  var hit = cache.get('allowlist-v1');
  if (hit) { try { return JSON.parse(hit); } catch (e) {} }

  var list = [];
  var sheetId = allowlistSheetId_();
  if (sheetId) {
    try {
      var ss = SpreadsheetApp.openById(sheetId);
      var sh = ALLOWLIST_SHEET_NAME ? ss.getSheetByName(ALLOWLIST_SHEET_NAME) : ss.getSheets()[0];
      if (sh) list = parseAllowlistValues_(sh.getDataRange().getValues());
    } catch (err) {
      // シートが読めないときは許可リストを空として扱う（ドメイン許可・管理者は有効のまま）
      console.warn('許可リストの読み込みに失敗: ' + err);
    }
  }
  try { cache.put('allowlist-v1', JSON.stringify(list), ALLOWLIST_CACHE_SEC); } catch (e) {}
  return list;
}

// スプレッドシートの中身から、許可するメールアドレスの一覧を取り出す
function parseAllowlistValues_(values) {
  var list = [];
  if (!values || values.length < 2) return list;

  var header = values[0].map(function (h) { return String(h).trim(); });
  // メールアドレスの列を探す（指定名 → 「メール」を含む列名 → @を含む値がある列）
  var ei = header.indexOf(ALLOWLIST_EMAIL_HEADER);
  if (ei === -1) {
    for (var i = 0; i < header.length; i++) {
      if (/メール|mail/i.test(header[i])) { ei = i; break; }
    }
  }
  if (ei === -1) {
    for (var c = 0; c < header.length; c++) {
      if (String(values[1][c] || '').indexOf('@') !== -1) { ei = c; break; }
    }
  }
  if (ei === -1) return list;

  var ai = ALLOWLIST_APPROVED_HEADER ? header.indexOf(ALLOWLIST_APPROVED_HEADER) : -1;
  for (var r = 1; r < values.length; r++) {
    var mail = lower_(values[r][ei]);
    if (!mail || mail.indexOf('@') === -1) continue;
    if (ai !== -1 && !isApproved_(values[r][ai])) continue;
    if (list.indexOf(mail) === -1) list.push(mail);
  }
  return list;
}

function isApproved_(v) {
  if (v === true) return true;
  return /^(true|1|yes|○|◯|承認|可|ok)$/i.test(String(v || '').trim());
}

/** 承認後すぐ反映したいときに、この関数を手動実行してキャッシュを消す */
function clearAllowlistCache() {
  CacheService.getScriptCache().remove('allowlist-v1');
  return '許可リストのキャッシュを消去しました（次のアクセスで最新が反映されます）';
}

// ===== 画面表示後の通信を認証するための署名付きトークン =====
// 最初のページ表示のときだけ本人確認ができるため、そこで短時間有効の
// トークンを発行し、以降のデータ取得（アプリ本体・ルート検索）で検証する。

function appSecret_() {
  var props = PropertiesService.getScriptProperties();
  var s = props.getProperty('APP_SECRET');
  if (!s) { s = Utilities.getUuid() + Utilities.getUuid(); props.setProperty('APP_SECRET', s); }
  return s;
}

function makeToken_(email) {
  var payload = (email || 'anonymous') + '|' + (Date.now() + 12 * 60 * 60 * 1000); // 12時間有効
  var sig = Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(payload, appSecret_()));
  return Utilities.base64EncodeWebSafe(payload) + '.' + sig;
}

function verifyToken_(t) {
  try {
    var parts = String(t || '').split('.');
    if (parts.length !== 2) return null;
    var payload = Utilities.newBlob(Utilities.base64DecodeWebSafe(parts[0])).getDataAsString();
    var sig = Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(payload, appSecret_()));
    if (sig !== parts[1]) return null;
    var seg = payload.split('|');
    if (Number(seg[1]) < Date.now()) return null;
    return seg[0];
  } catch (e) { return null; }
}

// 通信（アプリ取得・ルート検索）が許可されているか
function gateRequest_(p) {
  if (!ACCESS_CONTROL_ENABLED) return { ok: true };
  if (verifyToken_(p.t)) return { ok: true };
  return { ok: false, message: '利用の確認ができませんでした。アプリのURLを開き直してください。' };
}

// 未登録の人に見せる案内画面
function denyPage_(gate) {
  var applyBtn = APPLY_FORM_URL
    ? '<p style="margin-top:22px;"><a href="' + APPLY_FORM_URL + '" target="_blank" ' +
      'style="display:inline-block;background:#1a73e8;color:#fff;text-decoration:none;padding:13px 26px;border-radius:8px;font-weight:700;">' +
      '利用を申請する（フォームへ）</a></p>'
    : '';
  var who = gate.email
    ? '<p style="color:#666;font-size:13px;">ログイン中のアカウント：<b>' + gate.email + '</b></p>'
    : '';
  var extra = gate.reason === 'no-identity'
    ? '<p style="font-size:13px;color:#666;">別のアカウントでログインしている場合は、学校のアカウントに切り替えてからもう一度開いてください。</p>'
    : '<p style="font-size:13px;color:#666;">申請後、しばらく（最大5分ほど）してから開き直すと利用できるようになります。</p>';

  var html =
    '<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1.0"><title>利用申請のお願い</title></head>' +
    '<body style="margin:0;font-family:\'Segoe UI\',\'Yu Gothic UI\',Meiryo,sans-serif;background:#f0f2f5;">' +
    '<div style="max-width:560px;margin:8vh auto;background:#fff;border-radius:14px;padding:34px 30px;box-shadow:0 4px 18px rgba(0,0,0,.1);">' +
    '<h1 style="font-size:21px;color:#0d47a1;margin:0 0 14px;">出張距離測定・申請ガイド</h1>' +
    '<p style="font-size:15px;line-height:1.8;margin:0 0 6px;">' + (gate.message || '利用が許可されていません。') + '</p>' +
    '<p style="font-size:15px;line-height:1.8;">ご利用を希望される方は、下のフォームから申請してください。</p>' +
    applyBtn + extra + who +
    '</div></body></html>';

  return HtmlService.createHtmlOutput(html)
    .setTitle('利用申請のお願い')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function doGet(e) {
  var p = (e && e.parameter) || {};

  // ── 動作確認用：?whoami=1 で「自分のアカウントが認識されているか」を確認できる ──
  // 利用制限を有効にする前に、これで職員のアカウントが取得できるか必ず確かめること。
  // （表示されるのはアクセスした本人の情報だけなので安全です）
  if (p.whoami === '1') {
    var w = checkAccess_();
    return json_({
      ok: true,
      email: currentUserEmail_() || '(取得できませんでした)',
      allowed: w.ok,
      reason: w.reason || null,
      controlEnabled: ACCESS_CONTROL_ENABLED,
      hint: currentUserEmail_()
        ? 'アカウントを認識できています。allowed が true なら利用できます。'
        : 'アカウントを認識できていません。GASプロジェクトの所有者と利用者のドメインが違う可能性があります（下の「所有者について」を確認してください）。'
    });
  }

  // ── APIリクエスト（ルート検索 / 住所・施設検索）はJSONを返す ──
  if (p.origin || p.dest || p.q || p.mode) {
    var apiGate = gateRequest_(p);
    if (!apiGate.ok) return json_({ ok: false, error: apiGate.message, denied: true });
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
      var waypoints     = parseWaypoints_(p.waypoints);

      var routes = findRoutes_(origin, dest, {
        avoidHighways: avoidHighways,
        avoidTolls: avoidTolls,
        alternatives: alternatives,
        waypoints: waypoints
      });

      return json_({ ok: true, routes: routes });
    } catch (err) {
      return json_({ ok: false, error: String((err && err.message) || err) });
    }
  }

  // ── アプリ本体のHTMLを「テキスト」として返す（起動ページから読み込む用） ──
  // Apps Script に大きなHTMLを解釈させると document.write でエラーになるため、
  // HTMLは解釈させずテキストとして渡し、ブラウザ側で描画する。
  if (p.html === '1') {
    var htmlGate = gateRequest_(p);
    if (!htmlGate.ok) {
      return ContentService.createTextOutput(
        '<div style="font-family:sans-serif;padding:26px;line-height:1.8">' +
        '<h2>利用の確認ができませんでした</h2><p>' + htmlGate.message + '</p></div>')
        .setMimeType(ContentService.MimeType.TEXT);
    }
    try {
      // アプリ側から通信するときに使うトークンと、このGAS自身のURLを埋め込んで返す。
      // URLを渡すことで、学校ごとに別のGASを立てても各自のGASに通信が向く。
      var token = ACCESS_CONTROL_ENABLED ? String(p.t || '') : '';
      var inject = '<script>window.__APP_TOKEN=' + JSON.stringify(token) +
                   ';window.__GAS_URL=' + JSON.stringify(ScriptApp.getService().getUrl()) + ';<\/script>\n';
      return ContentService.createTextOutput(inject + fetchAppHtml_())
        .setMimeType(ContentService.MimeType.TEXT);
    } catch (err) {
      return ContentService.createTextOutput('<h2>取得失敗</h2><p>' + String((err && err.message) || err) + '</p>')
        .setMimeType(ContentService.MimeType.TEXT);
    }
  }

  // ── それ以外（パラメータなし）は、小さな「起動ページ」を配信する ──
  // この最初のアクセスだけは利用者のGoogleアカウントを確認できるので、
  // ここで利用可否を判定し、許可された人にだけトークン付きの起動ページを返す。
  var gate = checkAccess_();
  if (!gate.ok) return denyPage_(gate);
  return bootstrapPage_(ACCESS_CONTROL_ENABLED ? makeToken_(gate.email) : '');
}

// 小さな起動ページ。アプリ本体(HTML)をテキストで取得し、ブラウザ自身に描画させる。
// Apps Script の HTML 配信はこの小さなページだけなので壊れない。
function bootstrapPage_(token) {
  var self = ScriptApp.getService().getUrl();
  var url = self + '?html=1' + (token ? '&t=' + encodeURIComponent(token) : '');
  var boot =
    '<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1.0">' +
    '<style>html,body{margin:0;height:100%;font-family:sans-serif}#msg{padding:20px;color:#555}</style>' +
    '</head><body><div id="msg">読み込み中…</div>' +
    '<script>' +
    'fetch(' + JSON.stringify(url) + ')' +
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
      // 有料道路の有無は Google 公式の警告情報（warnings）から判定する。
      // 例：「この経路には有料道路が含まれています。」/ "This route has tolls."
      hasToll: (route.warnings || []).some(function (w) { return /有料|toll/i.test(String(w)); })
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
