/**
 * 出張距離測定・申請ガイド ─ 経路検索プロキシAPI（Google Apps Script）
 * =====================================================================
 * Google Cloud の APIキー・課金設定は一切不要です。
 * GAS に内蔵されている Maps サービス（Maps.newDirectionFinder）を使い、
 * Google マップの高精度なルートデータをフロントエンドに JSON で返します。
 *
 * 【デプロイ手順】
 *   1. https://script.google.com で新規プロジェクトを作成
 *   2. このコードを「コード.gs」に貼り付けて保存
 *   3. 右上「デプロイ」→「新しいデプロイ」
 *      - 種類: ウェブアプリ
 *      - 次のユーザーとして実行: 自分
 *      - アクセスできるユーザー: 全員（匿名を含む）
 *   4. 発行された「ウェブアプリ URL（.../exec）」をコピー
 *   5. index.html の GAS_API_URL にそのURLを貼り付け
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

function doGet(e) {
  try {
    var p = (e && e.parameter) || {};

    // パラメータなしで（ブラウザで直接URLを開くなどして）アクセスされた場合は、
    // 「APIは正常に稼働中」であることが分かる案内を返す（これはエラーではない）。
    if (!p.origin && !p.dest) {
      return json_({
        ok: true,
        status: 'ready',
        message: 'ルート検索APIは正常に稼働しています。origin と dest を指定してください。',
        example: '?origin=33.8835,130.8752&dest=33.8870,130.8800'
      });
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
      polyline: (route.overview_polyline && route.overview_polyline.points) || '',
      summary: route.summary || '',
      hasToll: false
    };
  });
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
