// hydrants.geojson のデータチェック
//
// 使い方: node scripts/check-data.mjs [hydrants.geojson] [直前の版の hydrants.geojson]
//   直前の版を渡すと「データを変えたのに更新日 (updated) がそのまま」も検出する。
// 追加のパッケージは不要（Node.js だけで動く）。

// 日本の範囲（これを外れた座標はエラー）
const JAPAN = {minLng: 122, maxLng: 154, minLat: 20, maxLat: 46};
// 全体の中心からこれより離れた点は入力ミスの疑いとして警告（メートル）
const OUTLIER_M = 3000;
// これより近い2点は重複登録の疑いとして警告（メートル）
const DUPLICATE_M = 5;
const TYPES = ['地下式', '地上式'];

function distanceM(a, b) {
    const rad = Math.PI / 180;
    const dLat = (b[1] - a[1]) * rad;
    const dLng = (b[0] - a[0]) * rad;
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(dLng / 2) ** 2;
    return 2 * 6371000 * Math.asin(Math.sqrt(s));
}

function median(values) {
    const sorted = [...values].sort((x, y) => x - y);
    return sorted[Math.floor(sorted.length / 2)];
}

// YYYY-MM-DD が実在する日付なら UTC のミリ秒を、そうでなければ null を返す
function parseDay(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        return null;
    }
    const time = Date.parse(value + 'T00:00:00Z');
    if (Number.isNaN(time) || new Date(time).toISOString().slice(0, 10) !== value) {
        return null;
    }
    return time;
}

/**
 * @param {string} text hydrants.geojson の中身
 * @param {{now?: Date, previousText?: string}} [options]
 * @returns {{errors: string[], warnings: string[], count: number, updated: string|null}}
 */
export function checkData(text, options = {}) {
    const now = options.now || new Date();
    // 日本時間で日付が先に変わっていても未来扱いしないよう、1日の余裕を持たせる
    const future = now.getTime() + 24 * 60 * 60 * 1000;
    const errors = [];
    const warnings = [];
    const result = {errors, warnings, count: 0, updated: null};

    let data;
    try {
        data = JSON.parse(text);
    } catch (e) {
        errors.push('JSON として読み込めません: ' + e.message);
        return result;
    }
    if (!data || data.type !== 'FeatureCollection' || !Array.isArray(data.features)) {
        errors.push('最上位は type が "FeatureCollection" で、features が配列である必要があります');
        return result;
    }
    result.count = data.features.length;
    if (data.features.length === 0) {
        errors.push('消火栓が1件もありません');
    }

    // ---- 更新日 ----
    const updatedTime = parseDay(data.updated);
    if (data.updated === undefined) {
        errors.push('更新日 "updated" がありません（例: "updated": "2026-11-15"）');
    } else if (updatedTime === null) {
        errors.push('更新日 "updated" は YYYY-MM-DD 形式の実在する日付にしてください: ' + JSON.stringify(data.updated));
    } else {
        result.updated = data.updated;
        if (updatedTime > future) {
            errors.push('更新日 "updated" が未来の日付です: ' + data.updated);
        }
    }

    // ---- 各消火栓 ----
    const seenIds = new Map();
    const points = [];
    let latestCreated = null;

    data.features.forEach((feature, index) => {
        const where = (feature && feature.id != null ? 'id ' + feature.id : (index + 1) + '件目') + ': ';
        const error = message => errors.push(where + message);
        const warn = message => warnings.push(where + message);

        if (!feature || feature.type !== 'Feature') {
            error('type が "Feature" ではありません');
            return;
        }

        // 番号
        if (!Number.isInteger(feature.id) || feature.id < 1) {
            error('id は 1 以上の整数にしてください');
        } else if (seenIds.has(feature.id)) {
            error('id が ' + seenIds.get(feature.id) + '件目と重複しています');
        } else {
            seenIds.set(feature.id, index + 1);
        }

        // 座標（[経度, 緯度] の順）
        const g = feature.geometry;
        let coordinates = null;
        if (!g || g.type !== 'Point' || !Array.isArray(g.coordinates) || g.coordinates.length < 2) {
            error('geometry は Point で、coordinates は [経度, 緯度] にしてください');
        } else {
            const [lng, lat] = g.coordinates;
            if (typeof lng !== 'number' || typeof lat !== 'number' || !Number.isFinite(lng) || !Number.isFinite(lat)) {
                error('座標は数値にしてください（文字列は不可）');
            } else if (lng >= JAPAN.minLat && lng <= JAPAN.maxLat && lat >= JAPAN.minLng && lat <= JAPAN.maxLng) {
                error('緯度と経度が逆です。[経度, 緯度] の順にしてください: [' + lng + ', ' + lat + ']');
            } else if (lng < JAPAN.minLng || lng > JAPAN.maxLng || lat < JAPAN.minLat || lat > JAPAN.maxLat) {
                error('座標が日本の範囲外です: [' + lng + ', ' + lat + ']');
            } else {
                coordinates = [lng, lat];
                points.push({where, coordinates});
            }
        }

        // 属性
        const props = feature.properties;
        if (!props || typeof props !== 'object') {
            error('properties がありません');
            return;
        }
        if (props.number !== feature.id) {
            error('properties.number (' + JSON.stringify(props.number) + ') が id と一致しません');
        }
        if (typeof props.name !== 'string' || props.name.trim() === '') {
            error('properties.name が空です');
        } else if (Number.isInteger(feature.id) && !props.name.includes('No.' + feature.id + '（')) {
            warn('名前 "' + props.name + '" に番号 No.' + feature.id + ' が入っていません');
        }
        if (!TYPES.includes(props.type)) {
            error('properties.type は ' + TYPES.join(' / ') + ' のどちらかにしてください: ' + JSON.stringify(props.type));
        } else if (typeof props.name === 'string' && !props.name.includes(props.type)) {
            warn('名前 "' + props.name + '" と type "' + props.type + '" が合っていません');
        }
        for (const key of ['address', 'aux_info']) {
            if (props[key] !== undefined && typeof props[key] !== 'string') {
                error('properties.' + key + ' は文字列にしてください');
            }
        }
        if (props.created !== undefined) {
            const created = typeof props.created === 'string' ? Date.parse(props.created) : NaN;
            if (Number.isNaN(created)) {
                error('properties.created を日時として読めません: ' + JSON.stringify(props.created));
            } else {
                if (created > future) {
                    error('properties.created が未来の日時です: ' + props.created);
                }
                if (latestCreated === null || created > latestCreated) {
                    latestCreated = created;
                }
            }
        }
    });

    // ---- 全体を見て分かること ----
    if (updatedTime !== null && latestCreated !== null) {
        // updated は日付だけなので、その日の終わりまでを含める
        if (latestCreated > updatedTime + 24 * 60 * 60 * 1000) {
            errors.push('更新日 "updated" (' + data.updated + ') が、いちばん新しい created より古くなっています');
        }
    }

    if (points.length > 0) {
        const center = [median(points.map(p => p.coordinates[0])), median(points.map(p => p.coordinates[1]))];
        for (const p of points) {
            const d = distanceM(center, p.coordinates);
            if (d > OUTLIER_M) {
                warnings.push(p.where + '他の消火栓から約 ' + Math.round(d) + ' m 離れています。座標を確認してください');
            }
        }
        for (let i = 0; i < points.length; i++) {
            for (let j = i + 1; j < points.length; j++) {
                const d = distanceM(points[i].coordinates, points[j].coordinates);
                if (d === 0) {
                    errors.push(points[j].where + points[i].where.replace(': ', '') + ' と座標がまったく同じです');
                } else if (d < DUPLICATE_M) {
                    warnings.push(points[j].where + points[i].where.replace(': ', '') + ' と約 ' + d.toFixed(1) + ' m しか離れていません。重複登録ではないか確認してください');
                }
            }
        }
    }

    // ---- 直前の版との比較 ----
    if (options.previousText) {
        let previous = null;
        try {
            previous = JSON.parse(options.previousText);
        } catch (e) {
            // 直前の版が壊れていたなら比較しない
        }
        if (previous && Array.isArray(previous.features) && previous.updated !== undefined) {
            const changed = JSON.stringify(previous.features) !== JSON.stringify(data.features);
            if (changed && previous.updated === data.updated) {
                errors.push('消火栓のデータが変わっていますが、更新日 "updated" が ' + data.updated + ' のままです。今日の日付に直してください');
            }
            const previousTime = parseDay(previous.updated);
            if (previousTime !== null && updatedTime !== null && updatedTime < previousTime) {
                errors.push('更新日 "updated" が直前の版 (' + previous.updated + ') より前に戻っています');
            }
        }
    }

    return result;
}

// ---- コマンドとして実行されたとき（ブラウザなどから import されたときは何もしない） ----
if (typeof process !== 'undefined' && process.argv && process.argv[1]) {
    const {pathToFileURL} = await import('node:url');
    if (import.meta.url === pathToFileURL(process.argv[1]).href) {
        const fs = await import('node:fs');
        const file = process.argv[2] || 'hydrants.geojson';
        const previousFile = process.argv[3];
        const previousText = previousFile && fs.existsSync(previousFile) ? fs.readFileSync(previousFile, 'utf8') : undefined;

        const {errors, warnings, count, updated} = checkData(fs.readFileSync(file, 'utf8'), {previousText});

        // GitHub Actions では注釈として表示される
        const inActions = Boolean(process.env.GITHUB_ACTIONS);
        const escape = message => message.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
        for (const message of warnings) {
            console.log(inActions ? '::warning file=' + file + '::' + escape(message) : '警告: ' + message);
        }
        for (const message of errors) {
            console.log(inActions ? '::error file=' + file + '::' + escape(message) : 'エラー: ' + message);
        }

        const summary = (errors.length === 0 ? 'OK' : 'NG') + ': ' + file + ' 消火栓 ' + count + '件 / 更新日 ' + (updated || '不明') +
            ' / エラー ' + errors.length + '件 / 警告 ' + warnings.length + '件';
        console.log(summary);
        if (process.env.GITHUB_STEP_SUMMARY) {
            const lines = ['### ' + (errors.length === 0 ? '✅ ' : '❌ ') + summary, '',
                ...errors.map(m => '- ❌ ' + m), ...warnings.map(m => '- ⚠️ ' + m), ''];
            fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join('\n'));
        }
        process.exit(errors.length === 0 ? 0 : 1);
    }
}
