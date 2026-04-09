(function () {
    "use strict";

    var PALETTE = ["#3d8bfd", "#7c5cff", "#3dd68c", "#ffb020", "#f14b5c", "#5ce7ff", "#c79bff", "#9abf6b"];

    var map;
    var YMapFeature;
    var YMapListener;
    /** Пока тащим объект/вершину — отключаем behavior «drag» у карты, иначе двигается карта, а не геометрия. */
    var mapBehaviorsBeforeDrag = null;
    var mapDragSuppressCount = 0;
    /** Слой поверх всех объектов: вершины и середины рёбер (иначе applyStackingOrder уводит полигоны выше ручек). */
    var vertexEditLayer = null;
    /** Модификаторы с реального pointer/mousedown (YMapListener часто не отдаёт shiftKey в объекте клика). */
    var mapPointerModifiers = { shift: false, ctrl: false, meta: false };
    var vertexEditorSyncScheduled = false;
    var vertexEditHandleList = [];
    /** Визуальные точки: ключ "entryId:vertexIndex" → YMapFeature */
    var vertexEditVisualByKey = new Map();
    var formFieldUid = 0;
    var lastMapZoomForVertex = 10;
    /** Активное перетаскивание вершины { entry, desc, idx, handleFeature } */
    var vertexDragState = null;
    /** Перетаскивание целого объекта: screenAnchor, boundsSnap, mapW/H зафиксированы на время жеста */
    var featureBodyDragState = null;
    var vertexDragSuppressedClick = false;
    var nextFeatureKey = 1;
    var nextStackKey = 1;
    var allEntries = [];
    var idToEntry = new Map();
    var featureEntityToEntry = new WeakMap();
    var logicalLayers = [];
    var hiddenStash = new Map();
    var nextLayerId = 1;
    var selectedOrder = [];
    var deletedObjects = [];
    var jstsReader = new jsts.io.GeoJSONReader();
    var jstsWriter = new jsts.io.GeoJSONWriter();

    var drawState = {
        mode: null,
        points: [],
        preview: null,
        rectCorner: null,
        vertexMarkers: [],
        rectCornerMarker: null,
        rectPreviewPoly: null,
        rectHover: null
    };

    /** Режимы, где карта ставит точки/фигуры; «move» только для переноса, не для рисования. */
    function isExclusiveDrawMode() {
        var m = drawState.mode;
        return m === "point" || m === "polyline" || m === "polygon" || m === "rect";
    }

    function layerById(id) {
        for (var i = 0; i < logicalLayers.length; i++) {
            if (logicalLayers[i].id === id) return logicalLayers[i];
        }
        return null;
    }

    function pickColor(index) {
        return PALETTE[index % PALETTE.length];
    }

    function toColorInputValue(hex) {
        if (!hex || typeof hex !== "string") return "#3388ff";
        hex = hex.trim();
        if (/^#[0-9a-fA-F]{6}$/.test(hex)) return hex.toLowerCase();
        if (/^#[0-9a-fA-F]{3}$/.test(hex)) {
            var h = hex.slice(1);
            return ("#" + h[0] + h[0] + h[1] + h[1] + h[2] + h[2]).toLowerCase();
        }
        return "#3388ff";
    }

    /**
     * Для Point в API 3 нужен style.element или icon.url; stroke/fill дают запрос «No icon url provided».
     */
    function pointMarkerElement(hex, selected) {
        var d = document.createElement("div");
        d.setAttribute("data-kml-point", "1");
        d.style.width = "16px";
        d.style.height = "16px";
        d.style.marginLeft = "-8px";
        d.style.marginTop = "-8px";
        d.style.borderRadius = "50%";
        d.style.background = hex;
        d.style.border = (selected ? "3px solid " : "2px solid ") + (selected ? "#ff5a7a" : "rgba(255,255,255,0.92)");
        d.style.boxSizing = "border-box";
        d.style.boxShadow = "0 1px 5px rgba(0,0,0,0.35)";
        d.style.pointerEvents = "auto";
        return d;
    }

    /** Номерованные маркеры вершин при рисовании линии/полигона/прямоугольника */
    function vertexHandleElement(index) {
        var d = document.createElement("div");
        d.setAttribute("data-kml-draw-vertex", "1");
        d.style.width = "14px";
        d.style.height = "14px";
        d.style.marginLeft = "-7px";
        d.style.marginTop = "-7px";
        d.style.borderRadius = "50%";
        d.style.background = "#ffffff";
        d.style.border = "2px solid #00e5ff";
        d.style.boxSizing = "border-box";
        d.style.boxShadow = "0 1px 4px rgba(0,0,0,0.35)";
        d.style.display = "flex";
        d.style.alignItems = "center";
        d.style.justifyContent = "center";
        d.style.fontSize = "8px";
        d.style.fontWeight = "700";
        d.style.color = "#082030";
        d.style.pointerEvents = "none";
        d.textContent = String(index + 1);
        return d;
    }

    /** Белая ручка вершины в режиме редактирования (как в конструкторе карт) */
    function vertexEditHandleElement() {
        var d = document.createElement("div");
        d.className = "map-vertex-handle";
        d.setAttribute("data-kml-vertex-edit", "1");
        return d;
    }

    /** Точка на середине ребра — клик добавляет вершину */
    function vertexMidHandleElement() {
        var d = document.createElement("div");
        d.className = "map-vertex-mid";
        d.setAttribute("data-kml-vertex-mid", "1");
        d.title = "Клик — новая вершина на ребре";
        return d;
    }

    function vertexEdgeMidpoint(desc, edgeIdx) {
        var a = desc.getCoord(edgeIdx);
        var b =
            desc.type === "Polygon"
                ? desc.getCoord((edgeIdx + 1) % desc.count)
                : desc.getCoord(edgeIdx + 1);
        return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    }

    function handleVertexMidClick(ent) {
        var parsed = parseVtxSuffixedId("vtxmid-", ent.id);
        if (!parsed) return;
        if (selectedOrder.length !== 1) return;
        var entry = selectedOrder[0];
        if (parsed.entryId !== entry.id) return;
        var desc = buildVertexEditDescriptors(entry);
        if (!desc || !desc.insertVertexAfterEdge || desc.edgeCount == null) return;
        if (parsed.num < 0 || parsed.num >= desc.edgeCount) return;
        var mid = vertexEdgeMidpoint(desc, parsed.num);
        desc.insertVertexAfterEdge(parsed.num, mid);
        pushEntryGeometryToYmap(entry);
        vertexDragSuppressedClick = true;
        setTimeout(function () {
            vertexDragSuppressedClick = false;
        }, 450);
        queueVertexEditorSync();
    }

    function hexToYmapStyle(hex, geomType, selected) {
        var strokeW = selected ? 4 : geomType === "LineString" || geomType === "MultiLineString" ? 3 : 2;
        var strokeHex = selected ? "#ff5a7a" : hex;
        var fillHex = selected ? "#ff5a7a38" : hex.length === 7 ? hex + "38" : hex;
        if (geomType === "Point" || geomType === "MultiPoint") {
            return { element: pointMarkerElement(hex, selected) };
        }
        if (geomType === "LineString" || geomType === "MultiLineString") {
            return {
                stroke: [{ color: strokeHex + (strokeHex.length === 7 ? "ee" : ""), width: strokeW }],
                interactive: true
            };
        }
        return {
            stroke: [{ color: strokeHex + (strokeHex.length === 7 ? "cc" : ""), width: strokeW }],
            fill: fillHex,
            interactive: true
        };
    }

    function styleForEntry(entry) {
        var g = entry.feature.geometry;
        var t = g ? g.type : "Polygon";
        return hexToYmapStyle(layerById(entry.logicalLayerId).color, t, entry.selected);
    }

    function invertCoordinates(geojson) {
        if (!geojson || !geojson.geometry) return;

        function invertCoords(coords) {
            if (typeof coords[0] === "number") {
                return [coords[1], coords[0]];
            }
            return coords.map(invertCoords);
        }

        var geom = geojson.geometry;
        if (geom.type === "GeometryCollection") {
            geom.geometries.forEach(function (g) {
                if (g.coordinates) g.coordinates = invertCoords(g.coordinates);
            });
        } else if (geom.coordinates) {
            geom.coordinates = invertCoords(geom.coordinates);
        }
    }

    function isPolygonalGeometry(g) {
        return g && (g.type === "Polygon" || g.type === "MultiPolygon");
    }

    function isPolygonalEntry(entry) {
        var g = entry.feature.geometry;
        return isPolygonalGeometry(g);
    }

    function updateSelectionBadge() {
        var el = document.getElementById("selection-info");
        if (el) el.textContent = "Выбрано: " + selectedOrder.length;
    }

    var layerListUpdateScheduled = false;
    /** Не прокручивать список к выделению (клик по строке в сайдбаре — объект уже на экране). */
    var skipScrollLayerListToSelection = false;
    /** Не дёргать scrollIntoView при каждой перерисовке, если выделение то же (цвет слоя, переименование). */
    var lastLayerListScrollSelectionSig = "";
    /**
     * Пока открыто поле переименования, нельзя вызывать updateLayerList: два click по строке ставят rAF,
     * он выполняется после dblclick и сносит только что вставленный input.
     */
    var layerListRenameLockId = null;

    function scheduleLayerListRefresh() {
        if (layerListUpdateScheduled) return;
        layerListUpdateScheduled = true;
        requestAnimationFrame(function () {
            layerListUpdateScheduled = false;
            if (layerListRenameLockId) {
                return;
            }
            updateLayerList();
            if (!skipScrollLayerListToSelection) {
                scrollLayerListToSelectedFeatures();
            }
            skipScrollLayerListToSelection = false;
        });
    }

    function scrollLayerListToSelectedFeatures() {
        if (!selectedOrder.length) {
            lastLayerListScrollSelectionSig = "";
            return;
        }
        var last = selectedOrder[selectedOrder.length - 1];
        if (!last || !last.id) return;
        var sig = String(last.id) + ":" + selectedOrder.length;
        if (sig === lastLayerListScrollSelectionSig) return;
        lastLayerListScrollSelectionSig = sig;
        var sid = String(last.id).replace(/"/g, "");
        var el = document.querySelector('.layer-object-row[data-feature-id="' + sid + '"]');
        if (!el) return;
        try {
            el.scrollIntoView({ block: "nearest", behavior: "smooth", inline: "nearest" });
        } catch (e) {
            try {
                el.scrollIntoView(true);
            } catch (e2) {
                /* ignore */
            }
        }
    }

    function entryExplicitName(entry) {
        var p = entry.feature.properties || {};
        var n = p.name;
        if (n == null) n = p.Name;
        if (n == null) n = p.title;
        return n != null ? String(n) : "";
    }

    function beginFeatureRename(entry, labelSpan) {
        if (labelSpan.parentNode && labelSpan.parentNode.querySelector(".layer-object-row__name-input")) {
            return;
        }
        layerListRenameLockId = entry.id;
        var p = entry.feature.properties || (entry.feature.properties = {});
        var input = document.createElement("input");
        input.type = "text";
        input.className = "layer-object-row__name-input";
        input.id = "feat-name-" + entry.id + "-" + ++formFieldUid;
        input.name = "feature-display-name";
        input.setAttribute("autocomplete", "off");
        input.value = entryExplicitName(entry);
        input.placeholder = "Имя объекта";

        function endRenameAndRefreshList() {
            layerListRenameLockId = null;
            scheduleLayerListRefresh();
        }

        function commit() {
            var v = input.value.trim();
            if (v) {
                p.name = v;
                if (Object.prototype.hasOwnProperty.call(p, "Name")) delete p.Name;
            } else {
                if (Object.prototype.hasOwnProperty.call(p, "name")) delete p.name;
                if (Object.prototype.hasOwnProperty.call(p, "Name")) delete p.Name;
            }
            endRenameAndRefreshList();
        }

        function onBlur() {
            input.removeEventListener("blur", onBlur);
            commit();
        }

        input.addEventListener("keydown", function (ev) {
            if (ev.key === "Enter") {
                ev.preventDefault();
                input.removeEventListener("blur", onBlur);
                commit();
            } else if (ev.key === "Escape") {
                ev.preventDefault();
                ev.stopPropagation();
                input.removeEventListener("blur", onBlur);
                endRenameAndRefreshList();
            }
        });

        input.addEventListener("blur", onBlur);
        labelSpan.replaceWith(input);
        input.focus();
        input.select();
    }

    function queueVertexEditorSync() {
        if (vertexEditorSyncScheduled) return;
        vertexEditorSyncScheduled = true;
        requestAnimationFrame(function () {
            vertexEditorSyncScheduled = false;
            syncVertexEditor();
        });
    }

    function ringIsClosed(ring) {
        if (!ring || ring.length < 2) return false;
        var a = ring[0];
        var b = ring[ring.length - 1];
        return Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9;
    }

    function isVertexEditHandleEntity(ent) {
        var id = ent && ent.id ? String(ent.id) : "";
        return id.indexOf("vtxvis-") === 0 || id.indexOf("vtx-") === 0;
    }

    function isVertexMidHandleEntity(ent) {
        var id = ent && ent.id ? String(ent.id) : "";
        return id.indexOf("vtxmid-") === 0;
    }

    /** id вида prefix + entryId + "-" + число (entryId может содержать «-», берём последний дефис). */
    function parseVtxSuffixedId(prefix, id) {
        var s = String(id);
        if (s.indexOf(prefix) !== 0) return null;
        var rest = s.slice(prefix.length);
        var li = rest.lastIndexOf("-");
        if (li <= 0) return null;
        var entryId = rest.slice(0, li);
        var num = parseInt(rest.slice(li + 1), 10);
        if (!Number.isFinite(num)) return null;
        return { entryId: entryId, num: num };
    }

    /** Порог «попадания» в вершину в градусах (зависит от zoom карты). */
    function getVertexHitThresholdDeg() {
        var z = lastMapZoomForVertex;
        try {
            if (map && map.location && typeof map.location.zoom === "number") {
                z = map.location.zoom;
            }
        } catch (e) {
            /* ignore */
        }
        z = Math.max(3, Math.min(22, z));
        var mPerPx = 40075000 / (256 * Math.pow(2, z));
        var degPerPx = mPerPx / 111320;
        return Math.max(degPerPx * 22, 0.000012);
    }

    /** В режиме «Перемещение» узкий порог — иначе вся площадь мелкого полигона считается «у вершины» и тело не тащится. */
    function getEffectiveVertexHitThresholdDeg() {
        var t = getVertexHitThresholdDeg();
        if (drawState.mode === "move") return t * 0.45;
        return t;
    }

    function preventDomEventDefault(event) {
        if (!event) return;
        var ne = event.nativeEvent || event.originalEvent || event;
        if (ne && typeof ne.preventDefault === "function") {
            ne.preventDefault();
        }
    }

    function suppressMapDragWhileDragging() {
        if (!map || typeof map.setBehaviors !== "function") return;
        if (mapDragSuppressCount === 0) {
            try {
                mapBehaviorsBeforeDrag =
                    typeof map.getBehaviors === "function"
                        ? map.getBehaviors().slice()
                        : ["drag", "scrollZoom", "pinchZoom", "dblClick"];
                var noDrag = mapBehaviorsBeforeDrag.filter(function (b) {
                    return b !== "drag";
                });
                map.setBehaviors(noDrag);
            } catch (e) {
                mapBehaviorsBeforeDrag = null;
            }
        }
        mapDragSuppressCount++;
    }

    function releaseMapDragWhileDragging() {
        if (mapDragSuppressCount <= 0) return;
        mapDragSuppressCount--;
        if (mapDragSuppressCount === 0 && mapBehaviorsBeforeDrag && map && typeof map.setBehaviors === "function") {
            try {
                map.setBehaviors(mapBehaviorsBeforeDrag);
            } catch (e2) {
                /* ignore */
            }
            mapBehaviorsBeforeDrag = null;
        }
    }

    function resetMapDragSuppression() {
        if (mapDragSuppressCount <= 0 && !mapBehaviorsBeforeDrag) return;
        mapDragSuppressCount = 0;
        if (mapBehaviorsBeforeDrag && map && typeof map.setBehaviors === "function") {
            try {
                map.setBehaviors(mapBehaviorsBeforeDrag);
            } catch (e) {
                /* ignore */
            }
        }
        mapBehaviorsBeforeDrag = null;
    }

    function minVertexDistSqFromPoint(entry, lngLat) {
        var g = entry && entry.feature && entry.feature.geometry;
        if (!g || !lngLat) return Infinity;
        var minD = Infinity;
        function considerRing(ring) {
            if (!ring || !ring.length) return;
            var n = ring.length;
            var limit =
                ring[0][0] === ring[n - 1][0] && ring[0][1] === ring[n - 1][1] ? n - 1 : n;
            for (var i = 0; i < limit; i++) {
                var dLng = ring[i][0] - lngLat[0];
                var dLat = ring[i][1] - lngLat[1];
                var d2 = dLng * dLng + dLat * dLat;
                if (d2 < minD) minD = d2;
            }
        }
        if (g.type === "Point") {
            var dLng0 = g.coordinates[0] - lngLat[0];
            var dLat0 = g.coordinates[1] - lngLat[1];
            return dLng0 * dLng0 + dLat0 * dLat0;
        }
        if (g.type === "LineString") {
            g.coordinates.forEach(function (pt) {
                var dLng = pt[0] - lngLat[0];
                var dLat = pt[1] - lngLat[1];
                var d2 = dLng * dLng + dLat * dLat;
                if (d2 < minD) minD = d2;
            });
            return minD;
        }
        if (g.type === "Polygon") {
            g.coordinates.forEach(considerRing);
            return minD;
        }
        if (g.type === "MultiPolygon") {
            g.coordinates.forEach(function (poly) {
                poly.forEach(considerRing);
            });
            return minD;
        }
        if (g.type === "MultiLineString") {
            g.coordinates.forEach(function (line) {
                line.forEach(function (pt) {
                    var dLng = pt[0] - lngLat[0];
                    var dLat = pt[1] - lngLat[1];
                    var d2 = dLng * dLng + dLat * dLat;
                    if (d2 < minD) minD = d2;
                });
            });
            return minD;
        }
        if (g.type === "MultiPoint") {
            g.coordinates.forEach(function (pt) {
                var dLng = pt[0] - lngLat[0];
                var dLat = pt[1] - lngLat[1];
                var d2 = dLng * dLng + dLat * dLat;
                if (d2 < minD) minD = d2;
            });
            return minD;
        }
        return Infinity;
    }

    /** Попадание в выбранный объект, если под курсором нет entity (заливка иногда не даёт hit). */
    function lngLatOnSelectedFeature(entry, lngLat) {
        if (!entry || !lngLat || !entry.feature || !entry.feature.geometry) return false;
        try {
            var g = entry.feature.geometry;
            var t = g.type;
            var ptFeat = { type: "Point", coordinates: lngLat };
            var pt = geoJsonGeometryToJsts(ptFeat);
            var gj = geoJsonGeometryToJsts(g);
            var tol = getVertexHitThresholdDeg();
            if (t === "Polygon" || t === "MultiPolygon") {
                return gj.contains(pt) || gj.intersects(pt);
            }
            if (t === "LineString" || t === "MultiLineString") {
                return typeof gj.distance === "function" && gj.distance(pt) <= tol * 2;
            }
            if (t === "Point") {
                return typeof gj.distance === "function" && gj.distance(pt) < tol * 0.25;
            }
            if (t === "MultiPoint") {
                return typeof gj.distance === "function" && gj.distance(pt) <= tol;
            }
        } catch (e) {
            /* ignore */
        }
        return false;
    }

    function pushEntryGeometryToYmap(entry) {
        if (!entry || !entry.ymapFeature || !entry.ymapFeature.update) return;
        try {
            entry.ymapFeature.update({
                geometry: JSON.parse(JSON.stringify(entry.feature.geometry))
            });
        } catch (e) {
            /* ignore */
        }
    }

    function translateGeometryFromSnapshot(targetGeom, snap, dx, dy) {
        if (!targetGeom || !snap || targetGeom.type !== snap.type) return;
        if (snap.type === "GeometryCollection" && snap.geometries) {
            for (var gi = 0; gi < snap.geometries.length; gi++) {
                translateGeometryFromSnapshot(targetGeom.geometries[gi], snap.geometries[gi], dx, dy);
            }
            return;
        }
        if (!snap.coordinates) return;
        (function walk(tCoords, sCoords) {
            if (typeof sCoords[0] === "number") {
                tCoords[0] = sCoords[0] + dx;
                tCoords[1] = sCoords[1] + dy;
                return;
            }
            for (var i = 0; i < sCoords.length; i++) {
                walk(tCoords[i], sCoords[i]);
            }
        })(targetGeom.coordinates, snap.coordinates);
    }

    /**
     * Перенос по событиям YMapListener (как вершины): window pointermove при захвате указателя картой часто не вызывается.
     * Якорь в пикселях считается от left/top контейнера, зафиксированных на mousedown.
     */
    function applyFeatureBodyDragFromMapListenerEvent(listenerEvent) {
        var s = featureBodyDragState;
        if (!s || !s.entry || !s.geomSnap || !s.anchorLngLat) return;
        var bounds = s.boundsSnap || (map && map.bounds);
        var w = s.mapW;
        var h = s.mapH;
        var dx;
        var dy;
        var pt = clientPointFromListenerDomEvent(listenerEvent);
        if (
            pt != null &&
            s.screenAnchor != null &&
            s.rectClientLeft != null &&
            s.rectClientTop != null &&
            bounds &&
            typeof w === "number" &&
            typeof h === "number" &&
            w >= 2 &&
            h >= 2
        ) {
            var sx = pt.x - s.rectClientLeft;
            var sy = pt.y - s.rectClientTop;
            var cur = lngLatFromMapScreenPxDims(sx, sy, bounds, w, h);
            var anc = lngLatFromMapScreenPxDims(
                s.screenAnchor[0],
                s.screenAnchor[1],
                bounds,
                w,
                h
            );
            if (!cur || !anc) {
                var cFb = lngLatFromDomEvent(listenerEvent);
                if (!cFb) return;
                dx = cFb[0] - s.anchorLngLat[0];
                dy = cFb[1] - s.anchorLngLat[1];
            } else {
                dx = cur[0] - anc[0];
                dy = cur[1] - anc[1];
            }
        } else {
            var c = lngLatFromDomEvent(listenerEvent);
            if (!c) return;
            dx = c[0] - s.anchorLngLat[0];
            dy = c[1] - s.anchorLngLat[1];
        }
        if (dx * dx + dy * dy > 4e-18) s.moved = true;
        translateGeometryFromSnapshot(s.entry.feature.geometry, s.geomSnap, dx, dy);
        pushEntryGeometryToYmap(s.entry);
        queueVertexEditorSync();
    }

    /**
     * Перенос всего объекта: один выбранный объект, клик по его геометрии не ближе порога к вершине.
     * Включается в режиме панели «Перемещение» или с зажатым Shift в режиме «Выбор».
     */
    function tryStartFeatureBodyDrag(domObject, event) {
        if (isExclusiveDrawMode()) return;
        if (vertexDragState) return;
        if (featureBodyDragState) return;
        if (!featureBodyDragModifierActive(event)) return;
        if (selectedOrder.length !== 1) return;
        var c = lngLatFromDomEvent(event);
        if (!c) return;
        var entry = selectedOrder[0];
        var g = entry.feature.geometry;
        if (!g) return;
        var t = g.type;
        if (
            t !== "Polygon" &&
            t !== "LineString" &&
            t !== "MultiPolygon" &&
            t !== "MultiLineString" &&
            t !== "Point" &&
            t !== "MultiPoint"
        ) {
            return;
        }

        var ent = domObject && domObject.type === "feature" && domObject.entity ? domObject.entity : null;
        if (ent && isVertexMidHandleEntity(ent)) return;
        if (ent && isVertexEditHandleEntity(ent)) return;
        if (ent) {
            var clicked = (ent.id && idToEntry.get(String(ent.id))) || featureEntityToEntry.get(ent);
            if (clicked && clicked !== entry) return;
        } else if (!lngLatOnSelectedFeature(entry, c)) {
            return;
        }

        if (t !== "Point" && t !== "MultiPoint") {
            var thr2b = getEffectiveVertexHitThresholdDeg();
            thr2b *= thr2b;
            if (minVertexDistSqFromPoint(entry, c) <= thr2b) return;
        }

        var ptDn = clientPointFromListenerDomEvent(event);
        var mapElDn = document.getElementById("map");
        if (!mapElDn) return;

        suppressMapDragWhileDragging();

        var rectSnap = mapElDn.getBoundingClientRect();
        var bLive = map && map.bounds;
        var boundsSnap = copyBoundsCorners(bLive);
        var screenAnchor = null;
        var rectClientLeft = null;
        var rectClientTop = null;
        if (ptDn) {
            rectClientLeft = rectSnap.left;
            rectClientTop = rectSnap.top;
            screenAnchor = [ptDn.x - rectSnap.left, ptDn.y - rectSnap.top];
        }

        featureBodyDragState = {
            entry: entry,
            screenAnchor: screenAnchor,
            rectClientLeft: rectClientLeft,
            rectClientTop: rectClientTop,
            boundsSnap: boundsSnap,
            mapW: rectSnap.width,
            mapH: rectSnap.height,
            geomSnap: JSON.parse(JSON.stringify(entry.feature.geometry)),
            moved: false,
            anchorLngLat: [Number(c[0]), Number(c[1])]
        };
        preventDomEventDefault(event);
    }

    /**
     * Перетаскивание: mousedown по выбранному полигону/линии рядом с вершиной (по координатам).
     * Маркеры vtxvis — только визуал (interactive: false): события часто приходят по самой линии/полигону
     * или без object — поэтому ищем ближайшую вершину в радиусе и не начинаем, если клик по другому объекту.
     */
    function tryStartVertexDrag(domObject, event) {
        if (isExclusiveDrawMode()) return;
        if (selectedOrder.length !== 1) return;
        var c = lngLatFromDomEvent(event);
        if (!c) return;
        var entry = selectedOrder[0];
        var ent = domObject && domObject.type === "feature" && domObject.entity ? domObject.entity : null;
        if (ent && isVertexMidHandleEntity(ent)) return;
        var desc = buildVertexEditDescriptors(entry);
        if (!desc) return;
        if (ent && isVertexEditHandleEntity(ent)) {
            var parsed = parseVtxSuffixedId("vtxvis-", ent.id);
            if (parsed && parsed.entryId === entry.id && parsed.num >= 0 && parsed.num < desc.count) {
                var hfDirect = vertexEditVisualByKey.get(entry.id + ":" + parsed.num) || null;
                vertexDragState = {
                    entry: entry,
                    desc: desc,
                    idx: parsed.num,
                    handleFeature: hfDirect
                };
                suppressMapDragWhileDragging();
                preventDomEventDefault(event);
            }
            return;
        }
        if (ent) {
            var clicked = (ent.id && idToEntry.get(String(ent.id))) || featureEntityToEntry.get(ent);
            if (clicked && clicked !== entry) return;
        }
        var thr2 = getEffectiveVertexHitThresholdDeg();
        thr2 *= thr2;
        var bestI = -1;
        var bestD = Infinity;
        for (var i = 0; i < desc.count; i++) {
            var vc = desc.getCoord(i);
            var dLng = vc[0] - c[0];
            var dLat = vc[1] - c[1];
            var d2 = dLng * dLng + dLat * dLat;
            if (d2 < bestD) {
                bestD = d2;
                bestI = i;
            }
        }
        if (bestI < 0 || bestD > thr2) return;
        var hf = vertexEditVisualByKey.get(entry.id + ":" + bestI) || null;
        vertexDragState = { entry: entry, desc: desc, idx: bestI, handleFeature: hf };
        suppressMapDragWhileDragging();
        preventDomEventDefault(event);
    }

    function onWindowVertexDragEnd() {
        var hadVertex = !!vertexDragState;
        var hadBody = !!featureBodyDragState;
        if (hadVertex || (hadBody && featureBodyDragState.moved)) {
            vertexDragSuppressedClick = true;
            setTimeout(function () {
                vertexDragSuppressedClick = false;
            }, 450);
        }
        vertexDragState = null;
        featureBodyDragState = null;
        if (hadVertex || hadBody) {
            releaseMapDragWhileDragging();
        }
    }

    function applyVertexDragAtLngLat(c) {
        if (!vertexDragState || !c) return;
        var entry = vertexDragState.entry;
        var desc = vertexDragState.desc;
        var idx = vertexDragState.idx;
        desc.setCoord(idx, c);
        pushEntryGeometryToYmap(entry);
        if (vertexDragState.handleFeature && vertexDragState.handleFeature.update) {
            vertexDragState.handleFeature.update({
                geometry: { type: "Point", coordinates: [c[0], c[1]] }
            });
        }
    }

    function buildPolygonRingDesc(g, polyIdx, ringIdx, isMulti) {
        var poly = g.coordinates[polyIdx];
        if (!poly) return null;
        var ring = poly[ringIdx];
        if (!ring || ring.length < 3) return null;
        var closed = ringIsClosed(ring);
        var count = closed ? ring.length - 1 : ring.length;
        var edgeCount = closed ? count : Math.max(0, count - 1);
        return {
            type: "Polygon",
            multi: isMulti,
            count: count,
            edgeCount: edgeCount,
            getCoord: function (i) {
                return ring[i];
            },
            setCoord: function (i, lngLat) {
                ring[i][0] = lngLat[0];
                ring[i][1] = lngLat[1];
                if (closed && i === 0) {
                    ring[ring.length - 1][0] = lngLat[0];
                    ring[ring.length - 1][1] = lngLat[1];
                }
            },
            insertVertexAfterEdge: function (edgeIdx, lngLat) {
                var n = closed ? ring.length - 1 : ring.length;
                if (edgeIdx < 0 || edgeIdx >= n) return false;
                var x = Number(lngLat[0]);
                var y = Number(lngLat[1]);
                var pt = [x, y];
                if (closed) {
                    if (edgeIdx < n - 1) {
                        ring.splice(edgeIdx + 1, 0, pt);
                    } else {
                        ring.splice(n, 0, pt);
                    }
                    ring[ring.length - 1][0] = ring[0][0];
                    ring[ring.length - 1][1] = ring[0][1];
                } else {
                    if (edgeIdx >= ring.length - 1) return false;
                    ring.splice(edgeIdx + 1, 0, pt);
                }
                return true;
            }
        };
    }

    /**
     * Описание редактируемых вершин: LineString / внешнее кольцо Polygon / первое кольцо первого полигона MultiPolygon.
     */
    function buildVertexEditDescriptors(entry) {
        var g = entry.feature.geometry;
        if (!g || !g.coordinates) return null;
        var t = g.type;
        if (t === "LineString") {
            if (g.coordinates.length < 2) return null;
            return {
                type: "LineString",
                count: g.coordinates.length,
                edgeCount: g.coordinates.length - 1,
                getCoord: function (i) {
                    return g.coordinates[i];
                },
                setCoord: function (i, lngLat) {
                    g.coordinates[i][0] = lngLat[0];
                    g.coordinates[i][1] = lngLat[1];
                },
                insertVertexAfterEdge: function (edgeIdx, lngLat) {
                    var coords = g.coordinates;
                    if (edgeIdx < 0 || edgeIdx >= coords.length - 1) return false;
                    coords.splice(edgeIdx + 1, 0, [Number(lngLat[0]), Number(lngLat[1])]);
                    return true;
                }
            };
        }
        if (t === "Polygon") {
            return buildPolygonRingDesc(g, 0, 0, false);
        }
        if (t === "MultiPolygon") {
            if (!g.coordinates[0] || !g.coordinates[0][0]) return null;
            return buildPolygonRingDesc(g, 0, 0, true);
        }
        if (t === "MultiLineString") {
            var line = g.coordinates[0];
            if (!line || line.length < 2) return null;
            return {
                type: "LineString",
                multi: true,
                count: line.length,
                edgeCount: line.length - 1,
                getCoord: function (i) {
                    return line[i];
                },
                setCoord: function (i, lngLat) {
                    line[i][0] = lngLat[0];
                    line[i][1] = lngLat[1];
                },
                insertVertexAfterEdge: function (edgeIdx, lngLat) {
                    if (edgeIdx < 0 || edgeIdx >= line.length - 1) return false;
                    line.splice(edgeIdx + 1, 0, [Number(lngLat[0]), Number(lngLat[1])]);
                    return true;
                }
            };
        }
        return null;
    }

    function vertexHandlesParent() {
        return vertexEditLayer || map;
    }

    function bringVertexEditLayerToFront() {
        if (!map || !vertexEditLayer) return;
        try {
            map.removeChild(vertexEditLayer);
        } catch (e) {
            /* ignore */
        }
        try {
            map.addChild(vertexEditLayer);
        } catch (e2) {
            /* ignore */
        }
    }

    function removeAllVertexEditHandles() {
        if (!map) return;
        var parent = vertexHandlesParent();
        vertexEditHandleList.forEach(function (f) {
            try {
                parent.removeChild(f);
            } catch (e) {
                /* ignore */
            }
        });
        vertexEditHandleList = [];
        vertexEditVisualByKey.clear();
        vertexDragState = null;
    }

    function syncVertexEditor() {
        removeAllVertexEditHandles();
        if (!map || isExclusiveDrawMode() || typeof YMapFeature !== "function") return;
        if (selectedOrder.length !== 1) return;
        var entry = selectedOrder[0];
        if (!entry || !idToEntry.get(entry.id)) return;
        var desc = buildVertexEditDescriptors(entry);
        if (!desc) return;
        for (var e = 0; e < desc.edgeCount; e++) {
            (function (edgeIdx) {
                var mc = vertexEdgeMidpoint(desc, edgeIdx);
                var midId = "vtxmid-" + entry.id + "-" + edgeIdx;
                var midF = new YMapFeature({
                    id: midId,
                    geometry: { type: "Point", coordinates: [Number(mc[0]), Number(mc[1])] },
                    style: {
                        element: vertexMidHandleElement(),
                        interactive: true,
                        zIndex: 10001
                    }
                });
                vertexHandlesParent().addChild(midF);
                vertexEditHandleList.push(midF);
            })(e);
        }
        for (var i = 0; i < desc.count; i++) {
            (function (idx) {
                var c = desc.getCoord(idx);
                var vid = "vtxvis-" + entry.id + "-" + idx;
                var hf = new YMapFeature({
                    id: vid,
                    geometry: { type: "Point", coordinates: [Number(c[0]), Number(c[1])] },
                    style: {
                        element: vertexEditHandleElement(),
                        interactive: true,
                        zIndex: 10003
                    }
                });
                vertexEditVisualByKey.set(entry.id + ":" + idx, hf);
                vertexHandlesParent().addChild(hf);
                vertexEditHandleList.push(hf);
            })(i);
        }
        bringVertexEditLayerToFront();
    }

    function setSelected(entry, on) {
        entry.selected = !!on;
        if (entry.ymapFeature && entry.ymapFeature.update) {
            entry.ymapFeature.update({ style: styleForEntry(entry) });
        }
        updateSelectionBadge();
        scheduleLayerListRefresh();
        queueVertexEditorSync();
    }

    function toggleEntrySelection(entry) {
        if (entry.selected) {
            setSelected(entry, false);
            selectedOrder = selectedOrder.filter(function (x) {
                return x !== entry;
            });
        } else {
            setSelected(entry, true);
            selectedOrder.push(entry);
        }
    }

    function bboxMerge(b, lng, lat) {
        if (!b) return { minLng: lng, maxLng: lng, minLat: lat, maxLat: lat };
        return {
            minLng: Math.min(b.minLng, lng),
            maxLng: Math.max(b.maxLng, lng),
            minLat: Math.min(b.minLat, lat),
            maxLat: Math.max(b.maxLat, lat)
        };
    }

    function bboxFromCoords(coords, b) {
        if (typeof coords[0] === "number") {
            return bboxMerge(b, coords[0], coords[1]);
        }
        for (var i = 0; i < coords.length; i++) {
            b = bboxFromCoords(coords[i], b);
        }
        return b;
    }

    function bboxFromGeometry(geom) {
        if (!geom || !geom.coordinates) return null;
        return bboxFromCoords(geom.coordinates, null);
    }

    function fitMapToBBox(b) {
        if (!b || !map || !map.setLocation) return;
        try {
            map.setLocation({
                bounds: [
                    [b.minLng, b.minLat],
                    [b.maxLng, b.maxLat]
                ],
                duration: 280
            });
        } catch (e) {
            /* ignore */
        }
    }

    function fitMapToEntries(list) {
        var b = null;
        list.forEach(function (e) {
            var bb = bboxFromGeometry(e.feature.geometry);
            if (bb) {
                b = b
                    ? {
                          minLng: Math.min(b.minLng, bb.minLng),
                          maxLng: Math.max(b.maxLng, bb.maxLng),
                          minLat: Math.min(b.minLat, bb.minLat),
                          maxLat: Math.max(b.maxLat, bb.maxLat)
                      }
                    : bb;
            }
        });
        if (b) fitMapToBBox(b);
    }

    function flattenFeatureToParts(feature) {
        var out = [];
        var g = feature.geometry;
        var p = feature.properties || {};
        if (!g) return out;
        if (g.type === "GeometryCollection" && g.geometries) {
            g.geometries.forEach(function (sub) {
                out = out.concat(
                    flattenFeatureToParts({
                        type: "Feature",
                        properties: p,
                        geometry: sub
                    })
                );
            });
            return out;
        }
        if (g.type === "MultiPolygon") {
            g.coordinates.forEach(function (ring) {
                out.push({
                    type: "Feature",
                    properties: JSON.parse(JSON.stringify(p)),
                    geometry: { type: "Polygon", coordinates: ring }
                });
            });
            return out;
        }
        if (g.type === "MultiLineString") {
            g.coordinates.forEach(function (line) {
                out.push({
                    type: "Feature",
                    properties: JSON.parse(JSON.stringify(p)),
                    geometry: { type: "LineString", coordinates: line }
                });
            });
            return out;
        }
        if (g.type === "MultiPoint") {
            g.coordinates.forEach(function (pt) {
                out.push({
                    type: "Feature",
                    properties: JSON.parse(JSON.stringify(p)),
                    geometry: { type: "Point", coordinates: pt }
                });
            });
            return out;
        }
        out.push({
            type: "Feature",
            properties: JSON.parse(JSON.stringify(p)),
            geometry: JSON.parse(JSON.stringify(g))
        });
        return out;
    }

    function expandGeoJSONToFeatures(geojson) {
        var list = [];
        if (geojson.type === "FeatureCollection" && geojson.features) {
            geojson.features.forEach(function (f) {
                list = list.concat(flattenFeatureToParts(f));
            });
        } else if (geojson.type === "Feature") {
            list = flattenFeatureToParts(geojson);
        } else if (geojson.type) {
            list = flattenFeatureToParts({ type: "Feature", properties: {}, geometry: geojson });
        }
        return list;
    }

    function clearDrawOverlays() {
        if (drawState.preview && map) {
            try {
                map.removeChild(drawState.preview);
            } catch (e) {
                /* ignore */
            }
        }
        drawState.preview = null;
        if (drawState.vertexMarkers.length && map) {
            drawState.vertexMarkers.forEach(function (m) {
                try {
                    map.removeChild(m);
                } catch (e) {
                    /* ignore */
                }
            });
        }
        drawState.vertexMarkers = [];
        if (drawState.rectCornerMarker && map) {
            try {
                map.removeChild(drawState.rectCornerMarker);
            } catch (e) {
                /* ignore */
            }
            drawState.rectCornerMarker = null;
        }
        if (drawState.rectPreviewPoly && map) {
            try {
                map.removeChild(drawState.rectPreviewPoly);
            } catch (e) {
                /* ignore */
            }
            drawState.rectPreviewPoly = null;
        }
    }

    function syncRectPreviewPoly(a, b) {
        if (!map || !a || !b) return;
        if (drawState.rectPreviewPoly) {
            try {
                map.removeChild(drawState.rectPreviewPoly);
            } catch (e) {
                /* ignore */
            }
            drawState.rectPreviewPoly = null;
        }
        var rf = rectFromCorners(a, b);
        drawState.rectPreviewPoly = new YMapFeature({
            geometry: rf.geometry,
            style: {
                stroke: [{ color: "#00e5ff", width: 2 }],
                fill: "rgba(0, 229, 255, 0.18)",
                interactive: false,
                zIndex: 9998
            }
        });
        map.addChild(drawState.rectPreviewPoly);
    }

    function refreshDrawOverlays() {
        clearDrawOverlays();
        if (!map || !isExclusiveDrawMode()) return;
        var strokePreview = {
            stroke: [{ color: "#00e5ff", width: 4 }],
            interactive: false,
            zIndex: 9999
        };
        if (drawState.mode === "polygon" || drawState.mode === "polyline") {
            drawState.points.forEach(function (pt, i) {
                var vf = new YMapFeature({
                    geometry: { type: "Point", coordinates: pt },
                    style: {
                        element: vertexHandleElement(i),
                        interactive: false,
                        zIndex: 10000
                    }
                });
                map.addChild(vf);
                drawState.vertexMarkers.push(vf);
            });
            var pts = drawState.points;
            if (drawState.mode === "polygon" && pts.length >= 2) {
                drawState.preview = new YMapFeature({
                    geometry: { type: "LineString", coordinates: pts.concat([pts[0]]) },
                    style: strokePreview
                });
                map.addChild(drawState.preview);
            } else if (drawState.mode === "polyline" && pts.length >= 2) {
                drawState.preview = new YMapFeature({
                    geometry: { type: "LineString", coordinates: pts },
                    style: strokePreview
                });
                map.addChild(drawState.preview);
            }
            return;
        }
        if (drawState.mode === "rect" && drawState.rectCorner) {
            var m = new YMapFeature({
                geometry: { type: "Point", coordinates: drawState.rectCorner },
                style: {
                    element: vertexHandleElement(0),
                    interactive: false,
                    zIndex: 10000
                }
            });
            map.addChild(m);
            drawState.rectCornerMarker = m;
            if (drawState.rectHover) {
                syncRectPreviewPoly(drawState.rectCorner, drawState.rectHover);
            }
        }
    }

    function setDrawUI() {
        var active = !!drawState.mode;
        var needFinish = drawState.mode === "polygon" || drawState.mode === "polyline";
        var fin = document.getElementById("draw-complete");
        var can = document.getElementById("draw-cancel");
        if (fin) fin.hidden = !needFinish || !active;
        if (can) can.hidden = !active;
        document.querySelectorAll("[data-draw-mode]").forEach(function (btn) {
            var m = btn.getAttribute("data-draw-mode");
            var on =
                (m === "select" && !drawState.mode) ||
                (drawState.mode && m === drawState.mode);
            btn.classList.toggle("is-active", on);
        });
    }

    function exitDraw(resetPoints) {
        drawState.mode = null;
        if (resetPoints) drawState.points = [];
        drawState.rectCorner = null;
        drawState.rectHover = null;
        clearDrawOverlays();
        setDrawUI();
        queueVertexEditorSync();
    }

    function startDrawMode(mode) {
        exitDraw(true);
        drawState.mode = mode;
        setDrawUI();
        if (mode === "rect") {
            toast("Два клика по карте — противоположные углы прямоугольника.");
        } else if (mode === "polygon") {
            toast("Клики по карте — вершины. «Завершить» — замкнуть полигон (мин. 3 точки).");
        } else if (mode === "polyline") {
            toast("Клики — узлы линии. «Завершить» — сохранить (мин. 2 точки).");
        } else if (mode === "point") {
            toast("Клик по карте — поставить точку.");
        }
    }

    function finishDrawPolygonOrLine() {
        var pts = drawState.points;
        if (drawState.mode === "polygon") {
            if (pts.length < 3) {
                toast("Нужно минимум 3 точки.");
                return;
            }
            var ring = pts.slice();
            if (ring[0][0] !== ring[ring.length - 1][0] || ring[0][1] !== ring[ring.length - 1][1]) {
                ring.push(pts[0]);
            }
            var feat = {
                type: "Feature",
                properties: {},
                geometry: { type: "Polygon", coordinates: [ring] }
            };
            exitDraw(true);
            openDrawTargetModal(feat);
            return;
        }
        if (drawState.mode === "polyline") {
            if (pts.length < 2) {
                toast("Нужно минимум 2 точки.");
                return;
            }
            var feat2 = {
                type: "Feature",
                properties: {},
                geometry: { type: "LineString", coordinates: pts.slice() }
            };
            exitDraw(true);
            openDrawTargetModal(feat2);
        }
    }

    function rectFromCorners(a, b) {
        var minLng = Math.min(a[0], b[0]);
        var maxLng = Math.max(a[0], b[0]);
        var minLat = Math.min(a[1], b[1]);
        var maxLat = Math.max(a[1], b[1]);
        return {
            type: "Feature",
            properties: {},
            geometry: {
                type: "Polygon",
                coordinates: [
                    [
                        [minLng, minLat],
                        [maxLng, minLat],
                        [maxLng, maxLat],
                        [minLng, maxLat],
                        [minLng, minLat]
                    ]
                ]
            }
        };
    }

    function isDrawOverlayEntity(ent) {
        if (!ent) return false;
        if (drawState.preview === ent) return true;
        if (drawState.rectCornerMarker === ent) return true;
        if (drawState.rectPreviewPoly === ent) return true;
        for (var i = 0; i < drawState.vertexMarkers.length; i++) {
            if (drawState.vertexMarkers[i] === ent) return true;
        }
        return false;
    }

    function isDataFeatureDomObject(domObject) {
        if (!domObject || domObject.type !== "feature" || !domObject.entity) return false;
        var ent = domObject.entity;
        if (isVertexEditHandleEntity(ent)) return false;
        if (isVertexMidHandleEntity(ent)) return false;
        if (isDrawOverlayEntity(ent)) return false;
        return !!(idToEntry.get(String(ent.id)) || featureEntityToEntry.get(ent));
    }

    function lngLatFromDomEvent(event) {
        if (!event || event.coordinates == null) return null;
        var c = event.coordinates;
        if (Array.isArray(c) && c.length >= 2) {
            return [Number(c[0]), Number(c[1])];
        }
        return null;
    }

    /**
     * География под точкой экрана в контейнере карты (соответствует видимым bounds).
     * Нужна для переноса объекта: в движении event.coordinates иногда привязан к полигону, а не к курсору.
     */
    /** Линейная проекция px → LngLat для заданных bounds и размера вьюпорта (как при старте перетаскивания). */
    function lngLatFromMapScreenPxDims(sx, sy, bounds, w, h) {
        if (!bounds || sx == null || sy == null || w < 2 || h < 2) return null;
        var c0 = bounds[0];
        var c1 = bounds[1];
        if (!c0 || !c1 || c0.length < 2 || c1.length < 2) return null;
        var minLng = Math.min(c0[0], c1[0]);
        var maxLng = Math.max(c0[0], c1[0]);
        var minLat = Math.min(c0[1], c1[1]);
        var maxLat = Math.max(c0[1], c1[1]);
        var lng = minLng + (Number(sx) / w) * (maxLng - minLng);
        var lat = maxLat - (Number(sy) / h) * (maxLat - minLat);
        return [lng, lat];
    }

    function copyBoundsCorners(b) {
        if (!b || !b[0] || !b[1]) return null;
        return [
            [Number(b[0][0]), Number(b[0][1])],
            [Number(b[1][0]), Number(b[1][1])]
        ];
    }

    /** Список / обычный DOM: Shift / Ctrl / ⌘ */
    function isSelectionModifierKey(nativeEv) {
        return (
            nativeEv &&
            (nativeEv.shiftKey === true ||
                nativeEv.ctrlKey === true ||
                nativeEv.metaKey === true)
        );
    }

    function extractNativeDomEventFromListener(listenerEvent) {
        if (!listenerEvent) return null;
        var e =
            listenerEvent.domEvent ||
            listenerEvent.nativeEvent ||
            listenerEvent.originalEvent ||
            listenerEvent.event;
        if (e) {
            if (
                typeof e.shiftKey === "boolean" ||
                typeof e.clientX === "number" ||
                typeof e.preventDefault === "function"
            ) {
                return e;
            }
        }
        if (typeof listenerEvent.shiftKey === "boolean") return listenerEvent;
        return null;
    }

    /** clientX/Y из Pointer/Mouse/Touch для синхронизации с getBoundingClientRect карты. */
    function clientPointFromListenerDomEvent(listenerEvent) {
        var dom =
            listenerEvent &&
            (listenerEvent.domEvent ||
                listenerEvent.nativeEvent ||
                listenerEvent.originalEvent ||
                listenerEvent.event);
        if (!dom) return null;
        if (typeof dom.clientX === "number" && typeof dom.clientY === "number") {
            return { x: dom.clientX, y: dom.clientY };
        }
        if (dom.touches && dom.touches.length && dom.touches[0]) {
            var t = dom.touches[0];
            if (typeof t.clientX === "number" && typeof t.clientY === "number") {
                return { x: t.clientX, y: t.clientY };
            }
        }
        if (dom.changedTouches && dom.changedTouches.length && dom.changedTouches[0]) {
            var ct = dom.changedTouches[0];
            if (typeof ct.clientX === "number" && typeof ct.clientY === "number") {
                return { x: ct.clientX, y: ct.clientY };
            }
        }
        return null;
    }

    /** Карта: модификаторы из DOM-клика или с последнего pointerdown по #map */
    function mapSelectionModifiersActive(listenerEvent) {
        var dom = extractNativeDomEventFromListener(listenerEvent);
        if (dom && (dom.shiftKey || dom.ctrlKey || dom.metaKey)) return true;
        return !!(mapPointerModifiers.shift || mapPointerModifiers.ctrl || mapPointerModifiers.meta);
    }

    function captureMapPointerModifiersFromDom(ev) {
        if (!ev) return;
        mapPointerModifiers.shift = !!ev.shiftKey;
        mapPointerModifiers.ctrl = !!ev.ctrlKey;
        mapPointerModifiers.meta = !!ev.metaKey;
    }

    /** Перенос целиком: в режиме «Перемещение» или с зажатым Shift (иначе ЛКМ крутит карту). */
    function featureBodyDragModifierActive(listenerEvent) {
        if (drawState.mode === "move") return true;
        var dom = extractNativeDomEventFromListener(listenerEvent);
        if (dom && !!dom.shiftKey) return true;
        return !!mapPointerModifiers.shift;
    }

    function handleMapDomInteraction(domObject, event) {
        var coords = lngLatFromDomEvent(event);
        if (isExclusiveDrawMode()) {
            if (!coords) return;
            if (domObject && domObject.entity && isVertexEditHandleEntity(domObject.entity)) return;
            if (domObject && domObject.entity && isVertexMidHandleEntity(domObject.entity)) return;
            if (isDataFeatureDomObject(domObject)) return;
            onMapClickForDraw(coords, domObject);
            return;
        }
        if (!domObject || !domObject.entity) return;
        var ent = domObject.entity;
        if (isVertexMidHandleEntity(ent)) {
            handleVertexMidClick(ent);
            return;
        }
        if (isVertexEditHandleEntity(ent)) return;
        var entry =
            (ent.id && idToEntry.get(String(ent.id))) || featureEntityToEntry.get(ent);
        if (!entry) return;
        if (mapSelectionModifiersActive(event)) {
            toggleEntrySelection(entry);
            return;
        }
        if (selectedOrder.length === 1 && selectedOrder[0] === entry && entry.selected) {
            toggleEntrySelection(entry);
            return;
        }
        clearSelection();
        selectedOrder.push(entry);
        setSelected(entry, true);
    }

    /** onClick (с задержкой) дублирует onFastClick — отсекаем второй вызов */
    var suppressDelayedClick = false;

    function onFastClickDom(object, event) {
        if (vertexDragSuppressedClick) return;
        suppressDelayedClick = true;
        setTimeout(function () {
            suppressDelayedClick = false;
        }, 450);
        var dom = extractNativeDomEventFromListener(event);
        if (dom) {
            mapPointerModifiers.shift = mapPointerModifiers.shift || !!dom.shiftKey;
            mapPointerModifiers.ctrl = mapPointerModifiers.ctrl || !!dom.ctrlKey;
            mapPointerModifiers.meta = mapPointerModifiers.meta || !!dom.metaKey;
        }
        handleMapDomInteraction(object, event);
    }

    function onDelayedClickDom(object, event) {
        if (vertexDragSuppressedClick) return;
        if (suppressDelayedClick) return;
        handleMapDomInteraction(object, event);
    }

    function onMapClickForDraw(coords, domObject) {
        var lng = coords[0];
        var lat = coords[1];
        if (drawState.mode === "point") {
            var pf = {
                type: "Feature",
                properties: {},
                geometry: { type: "Point", coordinates: [lng, lat] }
            };
            exitDraw(true);
            openDrawTargetModal(pf);
            return;
        }
        if (drawState.mode === "rect") {
            if (!drawState.rectCorner) {
                drawState.rectCorner = [lng, lat];
                drawState.rectHover = null;
                refreshDrawOverlays();
                toast("Второй клик — угол. Двигайте курсор — видно превью прямоугольника.");
            } else {
                var rf = rectFromCorners(drawState.rectCorner, [lng, lat]);
                drawState.rectCorner = null;
                drawState.rectHover = null;
                exitDraw(true);
                openDrawTargetModal(rf);
            }
            return;
        }
        if (drawState.mode === "polygon" || drawState.mode === "polyline") {
            drawState.points.push([lng, lat]);
            if (drawState.points.length === 1) {
                toast("Вершина 1 отмечена на карте. Добавляйте точки; контур — с 2-й. «Завершить» — сохранить.");
            }
            refreshDrawOverlays();
            setDrawUI();
        }
    }

    function addEntryToMapOrStash(entry) {
        var def = layerById(entry.logicalLayerId);
        if (def && def.visible) {
            map.addChild(entry.ymapFeature);
            entry.onMap = true;
        } else {
            if (!hiddenStash.has(entry.logicalLayerId)) hiddenStash.set(entry.logicalLayerId, []);
            hiddenStash.get(entry.logicalLayerId).push(entry);
            entry.onMap = false;
        }
    }

    function removeEntryFromParent(entry) {
        try {
            map.removeChild(entry.ymapFeature);
        } catch (e) {
            /* not on map */
        }
        entry.onMap = false;
    }

    function spliceEntryFromHiddenStash(entry) {
        var stash = hiddenStash.get(entry.logicalLayerId);
        if (!stash) return;
        var ix = stash.indexOf(entry);
        if (ix !== -1) stash.splice(ix, 1);
    }

    function moveEntryToLayer(entry, targetLayerId) {
        if (!entry || !layerById(targetLayerId)) return;
        if (entry.logicalLayerId === targetLayerId) return;
        var targetDef = layerById(targetLayerId);
        if (entry.onMap) {
            removeEntryFromParent(entry);
        } else {
            spliceEntryFromHiddenStash(entry);
        }
        entry.logicalLayerId = targetLayerId;
        if (entry.ymapFeature && entry.ymapFeature.update) {
            entry.ymapFeature.update({ style: styleForEntry(entry) });
        }
        addEntryToMapOrStash(entry);
        applyStackingOrder();
        scheduleLayerListRefresh();
        toast("Перенесено в слой «" + targetDef.name + "»");
    }

    var layerDropHighlightEl = null;

    function clearLayerDropHighlights() {
        if (layerDropHighlightEl) {
            layerDropHighlightEl.classList.remove("is-drop-target-hover");
            layerDropHighlightEl = null;
        }
    }

    function layerListDragTypesHasOurs(types) {
        if (!types || !types.length) return false;
        for (var i = 0; i < types.length; i++) {
            if (types[i] === "application/x-kml-editor-feature-id") return true;
        }
        return false;
    }

    function bindLayerListDragAndDrop() {
        var root = document.getElementById("layer-list");
        if (!root || root.getAttribute("data-layer-dnd-bound") === "1") return;
        root.setAttribute("data-layer-dnd-bound", "1");

        root.addEventListener("dragover", function (ev) {
            if (layerListRenameLockId) return;
            if (!layerListDragTypesHasOurs(ev.dataTransfer.types)) return;
            var zone = ev.target.closest("[data-layer-drop-target]");
            if (!zone) return;
            ev.preventDefault();
            ev.dataTransfer.dropEffect = "move";
            if (layerDropHighlightEl !== zone) {
                clearLayerDropHighlights();
                layerDropHighlightEl = zone;
                zone.classList.add("is-drop-target-hover");
            }
        });

        root.addEventListener("drop", function (ev) {
            if (!layerListDragTypesHasOurs(ev.dataTransfer.types)) return;
            var zone = ev.target.closest("[data-layer-drop-target]");
            if (!zone) return;
            ev.preventDefault();
            clearLayerDropHighlights();
            var targetLayerId = zone.getAttribute("data-layer-drop-target");
            var fid = ev.dataTransfer.getData("application/x-kml-editor-feature-id");
            if (!fid) {
                var tp = ev.dataTransfer.getData("text/plain");
                if (tp && tp.indexOf("kml-editor-fid:") === 0) {
                    fid = tp.slice("kml-editor-fid:".length);
                }
            }
            if (!fid || !targetLayerId) return;
            var entry = idToEntry.get(fid);
            if (!entry) return;
            moveEntryToLayer(entry, targetLayerId);
        });

        root.addEventListener("dragleave", function (ev) {
            if (!ev.relatedTarget || !root.contains(ev.relatedTarget)) {
                clearLayerDropHighlights();
            }
        });

        document.addEventListener("dragend", clearLayerDropHighlights);
    }

    function createFeatureEntry(geojsonFeature, layerId) {
        var fid = "kml-" + nextFeatureKey++;
        var entry = {
            id: fid,
            logicalLayerId: layerId,
            feature: JSON.parse(JSON.stringify(geojsonFeature)),
            ymapFeature: null,
            selected: false,
            onMap: false,
            stackKey: nextStackKey++
        };
        var st = hexToYmapStyle(layerById(layerId).color, entry.feature.geometry.type, false);
        entry.ymapFeature = new YMapFeature({
            id: fid,
            geometry: JSON.parse(JSON.stringify(entry.feature.geometry)),
            style: st
        });
        idToEntry.set(fid, entry);
        featureEntityToEntry.set(entry.ymapFeature, entry);
        allEntries.push(entry);
        addEntryToMapOrStash(entry);
        applyStackingOrder();
        scheduleLayerListRefresh();
        return entry;
    }

    function importGeoJSONToLayer(geojson, layerId) {
        var parts = expandGeoJSONToFeatures(geojson);
        var created = [];
        parts.forEach(function (f) {
            created.push(createFeatureEntry(f, layerId));
        });
        return created;
    }

    function applyStackingOrder() {
        var orderMap = new Map();
        logicalLayers.forEach(function (l, i) {
            orderMap.set(l.id, i);
        });
        var vis = allEntries.filter(function (e) {
            return e.onMap;
        });
        vis.sort(function (a, b) {
            var ia = orderMap.get(a.logicalLayerId);
            var ib = orderMap.get(b.logicalLayerId);
            if (ia == null) ia = 999;
            if (ib == null) ib = 999;
            if (ia !== ib) return ia - ib;
            return a.stackKey - b.stackKey;
        });
        vis.forEach(function (e) {
            try {
                map.removeChild(e.ymapFeature);
            } catch (err) {
                /* ignore */
            }
        });
        vis.forEach(function (e) {
            map.addChild(e.ymapFeature);
        });
        bringVertexEditLayerToFront();
        if (isExclusiveDrawMode()) {
            refreshDrawOverlays();
        } else if (selectedOrder.length === 1) {
            queueVertexEditorSync();
        }
    }

    function refreshStylesForLogicalLayer(layerId) {
        allEntries.forEach(function (e) {
            if (e.logicalLayerId !== layerId) return;
            if (e.ymapFeature && e.ymapFeature.update) {
                e.ymapFeature.update({ style: styleForEntry(e) });
            }
        });
    }

    function addLogicalLayer(name) {
        var id = "L" + nextLayerId++;
        var def = {
            id: id,
            name: name || "Слой " + logicalLayers.length + 1,
            color: pickColor(logicalLayers.length),
            visible: true
        };
        logicalLayers.push(def);
        hiddenStash.set(id, []);
        updateLayerList();
        updateImportSelect();
        return id;
    }

    function destroyEntry(entry) {
        removeEntryFromParent(entry);
        var stash = hiddenStash.get(entry.logicalLayerId);
        if (stash) {
            var ix = stash.indexOf(entry);
            if (ix !== -1) stash.splice(ix, 1);
        }
        idToEntry.delete(entry.id);
        featureEntityToEntry.delete(entry.ymapFeature);
        selectedOrder = selectedOrder.filter(function (x) {
            return x !== entry;
        });
        updateSelectionBadge();
        var j = allEntries.indexOf(entry);
        if (j !== -1) allEntries.splice(j, 1);
        try {
            map.removeChild(entry.ymapFeature);
        } catch (e) {
            /* ignore */
        }
        scheduleLayerListRefresh();
        queueVertexEditorSync();
    }

    function removeLogicalLayer(id) {
        allEntries
            .filter(function (e) {
                return e.logicalLayerId === id;
            })
            .slice()
            .forEach(destroyEntry);
        hiddenStash.delete(id);
        logicalLayers = logicalLayers.filter(function (x) {
            return x.id !== id;
        });
        selectedOrder = selectedOrder.filter(function (e) {
            return e.logicalLayerId !== id;
        });
        scheduleLayerListRefresh();
        updateImportSelect();
        updateSelectionBadge();
    }

    function setLayerVisibility(id, visible) {
        var def = layerById(id);
        if (!def) return;
        def.visible = visible;
        if (visible) {
            var stash = hiddenStash.get(id) || [];
            stash.forEach(function (e) {
                map.addChild(e.ymapFeature);
                e.onMap = true;
            });
            hiddenStash.set(id, []);
        } else {
            var toHide = allEntries.filter(function (e) {
                return e.logicalLayerId === id && e.onMap;
            });
            toHide.forEach(function (e) {
                try {
                    map.removeChild(e.ymapFeature);
                } catch (err) {
                    /* ignore */
                }
                e.onMap = false;
            });
            var prevStash = hiddenStash.get(id) || [];
            hiddenStash.set(id, prevStash.concat(toHide));
        }
        applyStackingOrder();
    }

    function moveLayer(index, dir) {
        var j = index + dir;
        if (j < 0 || j >= logicalLayers.length) return;
        var t = logicalLayers[index];
        logicalLayers[index] = logicalLayers[j];
        logicalLayers[j] = t;
        scheduleLayerListRefresh();
        applyStackingOrder();
    }

    function updateImportSelect() {
        var sel = document.getElementById("import-target-layer");
        if (!sel) return;
        sel.innerHTML = "";
        logicalLayers.forEach(function (l) {
            var o = document.createElement("option");
            o.value = l.id;
            o.textContent = l.name;
            sel.appendChild(o);
        });
    }

    function geometryTypeLabel(geomType) {
        if (!geomType) return "Объект";
        if (geomType === "Point") return "Точка";
        if (geomType === "MultiPoint") return "Точки";
        if (geomType === "LineString") return "Линия";
        if (geomType === "MultiLineString") return "Линии";
        if (geomType === "Polygon") return "Полигон";
        if (geomType === "MultiPolygon") return "Полигоны";
        return "Объект";
    }

    function entryGeometryKind(entry) {
        var t = (entry.feature.geometry && entry.feature.geometry.type) || "";
        if (t === "Point" || t === "MultiPoint") return "point";
        if (t === "LineString" || t === "MultiLineString") return "line";
        if (t === "Polygon" || t === "MultiPolygon") return "polygon";
        return "other";
    }

    function entryDisplayName(entry) {
        var p = entry.feature.properties || {};
        var n = p.name;
        if (n == null) n = p.Name;
        if (n == null) n = p.title;
        if (n == null && typeof p.description === "string") {
            var plain = p.description.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
            if (plain) n = plain.length > 42 ? plain.slice(0, 39) + "…" : plain;
        }
        if (n != null && String(n).trim()) return String(n).trim();
        var gt = entry.feature.geometry && entry.feature.geometry.type;
        return geometryTypeLabel(gt) + " · " + entry.id.replace(/^kml-/, "").slice(0, 8);
    }

    function updateLayerList() {
        var ul = document.getElementById("layer-list");
        if (!ul) return;
        ul.innerHTML = "";
        logicalLayers.forEach(function (def, index) {
            var li = document.createElement("li");
            li.className = "layer-card" + (def.visible ? "" : " layer-card--layer-hidden");

            var row1 = document.createElement("div");
            row1.className = "layer-card__row";
            var colorInput = document.createElement("input");
            colorInput.type = "color";
            colorInput.className = "layer-card__color";
            colorInput.id = "layer-color-" + def.id;
            colorInput.name = "layer-color-" + def.id;
            colorInput.value = toColorInputValue(def.color);
            colorInput.title = "Цвет слоя на карте";
            colorInput.addEventListener("input", function () {
                def.color = colorInput.value;
                refreshStylesForLogicalLayer(def.id);
            });
            colorInput.addEventListener("change", function () {
                def.color = colorInput.value;
                refreshStylesForLogicalLayer(def.id);
                scheduleLayerListRefresh();
            });
            var vis = document.createElement("input");
            vis.type = "checkbox";
            vis.id = "layer-vis-" + def.id;
            vis.name = "layer-visible-" + def.id;
            vis.checked = def.visible;
            vis.title = "Видимость";
            vis.addEventListener("change", function () {
                setLayerVisibility(def.id, vis.checked);
            });
            var name = document.createElement("input");
            name.type = "text";
            name.className = "layer-card__name";
            name.id = "layer-name-" + def.id;
            name.name = "layer-name-" + def.id;
            name.setAttribute("autocomplete", "off");
            name.value = def.name;
            name.addEventListener("change", function () {
                var n = name.value.trim() || def.name;
                def.name = n;
                updateImportSelect();
            });
            row1.appendChild(colorInput);
            row1.appendChild(vis);
            row1.appendChild(name);

            var row2 = document.createElement("div");
            row2.className = "layer-card__actions";
            var order = document.createElement("div");
            order.className = "layer-card__order";
            var up = document.createElement("button");
            up.type = "button";
            up.className = "btn btn--ghost";
            up.textContent = "▲";
            up.disabled = index === 0;
            up.addEventListener("click", function () {
                moveLayer(index, -1);
            });
            var down = document.createElement("button");
            down.type = "button";
            down.className = "btn btn--ghost";
            down.textContent = "▼";
            down.disabled = index === logicalLayers.length - 1;
            down.addEventListener("click", function () {
                moveLayer(index, 1);
            });
            order.appendChild(up);
            order.appendChild(down);

            var del = document.createElement("button");
            del.type = "button";
            del.className = "btn btn--danger";
            del.textContent = "Удалить слой";
            del.addEventListener("click", function () {
                if (logicalLayers.length <= 1) {
                    toast("Нужен минимум один слой.");
                    return;
                }
                if (confirm("Удалить слой «" + def.name + "» и все его объекты?")) {
                    removeLogicalLayer(def.id);
                }
            });

            row2.appendChild(order);
            row2.appendChild(del);

            var objectsBlock = document.createElement("div");
            objectsBlock.className = "layer-card__objects";
            objectsBlock.setAttribute("data-layer-drop-target", def.id);
            var objectsHead = document.createElement("div");
            objectsHead.className = "layer-card__objects-head";
            var layerEntries = allEntries.filter(function (e) {
                return e.logicalLayerId === def.id;
            });
            objectsBlock.title = layerEntries.length
                ? "Перетащите сюда объект с ручки ⋮⋮"
                : "KML: перетащите файлы в пунктирную область ниже или нажмите на неё. Объект из другого слоя — ручка ⋮⋮.";
            objectsHead.appendChild(document.createTextNode("Объекты "));
            var countSpan = document.createElement("span");
            countSpan.className = "layer-card__objects-count";
            countSpan.textContent = "(" + layerEntries.length + ")";
            objectsHead.appendChild(countSpan);
            objectsBlock.appendChild(objectsHead);

            if (!layerEntries.length) {
                var emptyImport = document.createElement("div");
                emptyImport.className = "layer-card__empty-import";
                var inId = "layer-kml-" + String(def.id).replace(/[^a-zA-Z0-9_-]/g, "_");
                var dropLabel = document.createElement("label");
                dropLabel.className = "file-drop file-drop--in-layer";
                dropLabel.setAttribute("data-layer-import-id", def.id);
                dropLabel.setAttribute("for", inId);
                var layerFileIn = document.createElement("input");
                layerFileIn.type = "file";
                layerFileIn.id = inId;
                layerFileIn.name = "kml-layer-" + inId;
                layerFileIn.accept = ".kml,application/vnd.google-earth.kml+xml,text/xml";
                layerFileIn.multiple = true;
                layerFileIn.setAttribute("data-layer-kml-input", def.id);
                var spImp1 = document.createElement("span");
                spImp1.className = "file-drop__text";
                spImp1.textContent = "Перетащите KML сюда или нажмите";
                var spImp2 = document.createElement("span");
                spImp2.className = "file-drop__meta";
                spImp2.textContent = "Несколько KML за раз — всё в этот слой";
                dropLabel.appendChild(layerFileIn);
                dropLabel.appendChild(spImp1);
                dropLabel.appendChild(spImp2);
                emptyImport.appendChild(dropLabel);
                objectsBlock.appendChild(emptyImport);
            } else {
                var subUl = document.createElement("ul");
                subUl.className = "layer-object-list";
                layerEntries.forEach(function (entry) {
                    var oLi = document.createElement("li");
                    oLi.className = "layer-object-row" + (entry.selected ? " is-selected" : "");
                    oLi.setAttribute("data-feature-id", entry.id);
                    oLi.title =
                        "Клик — одно выделение. Shift, Ctrl или ⌘ + клик — добавить/убрать в выборе (разные слои, операции ∪∩−). Двойной клик по строке — карта. По имени — переименовать. Ручка ⋮⋮ — перенос слоя.";

                    var dragHandle = document.createElement("span");
                    dragHandle.className = "layer-object-row__drag";
                    dragHandle.draggable = true;
                    dragHandle.title = "Потяните в блок «Объекты» другого слоя";
                    dragHandle.setAttribute("aria-grabbed", "false");
                    dragHandle.addEventListener("dragstart", function (ev) {
                        if (layerListRenameLockId) {
                            ev.preventDefault();
                            return;
                        }
                        ev.stopPropagation();
                        try {
                            ev.dataTransfer.setData("application/x-kml-editor-feature-id", entry.id);
                            ev.dataTransfer.setData("text/plain", "kml-editor-fid:" + entry.id);
                        } catch (e) {
                            ev.dataTransfer.setData("text/plain", "kml-editor-fid:" + entry.id);
                        }
                        ev.dataTransfer.effectAllowed = "move";
                        oLi.classList.add("is-dragging");
                        dragHandle.setAttribute("aria-grabbed", "true");
                    });
                    dragHandle.addEventListener("dragend", function () {
                        oLi.classList.remove("is-dragging");
                        dragHandle.setAttribute("aria-grabbed", "false");
                        clearLayerDropHighlights();
                    });

                    var glyph = document.createElement("span");
                    glyph.className =
                        "layer-object-row__glyph layer-object-row__glyph--" + entryGeometryKind(entry);
                    glyph.style.color = def.color;
                    glyph.setAttribute("aria-hidden", "true");

                    var label = document.createElement("span");
                    label.className = "layer-object-row__name";
                    label.textContent = entryDisplayName(entry);
                    label.title = "Двойной клик — изменить имя";
                    label.addEventListener("dblclick", function (ev) {
                        ev.preventDefault();
                        ev.stopPropagation();
                        beginFeatureRename(entry, label);
                    });

                    var delObj = document.createElement("button");
                    delObj.type = "button";
                    delObj.className = "btn btn--ghost layer-object-row__delete";
                    delObj.textContent = "×";
                    delObj.title = "Удалить объект";
                    delObj.addEventListener("click", function (ev) {
                        ev.stopPropagation();
                        var snap = JSON.parse(JSON.stringify(entry.feature));
                        var lid = entry.logicalLayerId;
                        destroyEntry(entry);
                        toast("Объект удалён", "Отменить", function () {
                            createFeatureEntry(snap, lid);
                        });
                    });

                    oLi.addEventListener("click", function (ev) {
                        if (ev.target.closest(".layer-object-row__delete")) return;
                        if (ev.target.closest(".layer-object-row__name-input")) return;
                        skipScrollLayerListToSelection = true;
                        if (isSelectionModifierKey(ev)) {
                            toggleEntrySelection(entry);
                            return;
                        }
                        if (selectedOrder.length === 1 && selectedOrder[0] === entry && entry.selected) {
                            toggleEntrySelection(entry);
                            return;
                        }
                        clearSelection();
                        selectedOrder.push(entry);
                        setSelected(entry, true);
                    });
                    oLi.addEventListener("dblclick", function (ev) {
                        ev.preventDefault();
                        ev.stopPropagation();
                        var bb = bboxFromGeometry(entry.feature.geometry);
                        if (bb) fitMapToBBox(bb);
                    });

                    oLi.appendChild(dragHandle);
                    oLi.appendChild(glyph);
                    oLi.appendChild(label);
                    oLi.appendChild(delObj);
                    subUl.appendChild(oLi);
                });
                objectsBlock.appendChild(subUl);
            }

            li.appendChild(row1);
            li.appendChild(row2);
            li.appendChild(objectsBlock);
            ul.appendChild(li);
        });
    }

    function entryToGeoJSON(entry) {
        return JSON.parse(JSON.stringify(entry.feature));
    }

    function getAllFeatures() {
        return allEntries.map(entryToGeoJSON);
    }

    /**
     * Кольцо: только пары [lng, lat]; иначе tokml падает на cds.join (получает число).
     */
    function sanitizeRingCoords(coords, minPoints) {
        if (!Array.isArray(coords)) return null;
        var out = [];
        for (var i = 0; i < coords.length; i++) {
            var p = coords[i];
            if (!Array.isArray(p) || p.length < 2) continue;
            var lng = Number(p[0]);
            var lat = Number(p[1]);
            if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue;
            out.push([lng, lat]);
        }
        if (out.length < minPoints) return null;
        return out;
    }

    function sanitizePolygonCoordsAllRings(polyCoords) {
        if (!Array.isArray(polyCoords) || !polyCoords.length) return null;
        var ringsOut = [];
        for (var r = 0; r < polyCoords.length; r++) {
            var sr = sanitizeRingCoords(polyCoords[r], 4);
            if (sr) ringsOut.push(sr);
        }
        return ringsOut.length ? ringsOut : null;
    }

    /**
     * Часть MultiPolygon: либо [внешнее, дыры...], либо ошибочно одно кольцо [[lng,lat],...].
     */
    function normalizeMultiPolygonPart(part) {
        if (!Array.isArray(part) || !part.length) return null;
        var first = part[0];
        if (Array.isArray(first) && typeof first[0] === "number") {
            return sanitizePolygonCoordsAllRings([part]);
        }
        if (Array.isArray(first) && Array.isArray(first[0])) {
            return sanitizePolygonCoordsAllRings(part);
        }
        return null;
    }

    function sanitizeGeometryForTokml(geom) {
        if (!geom || !geom.type) return null;
        var t = geom.type;
        if (t === "Point") {
            var pc = geom.coordinates;
            if (!Array.isArray(pc) || pc.length < 2) return null;
            var lng0 = Number(pc[0]);
            var lat0 = Number(pc[1]);
            if (!Number.isFinite(lng0) || !Number.isFinite(lat0)) return null;
            return { type: "Point", coordinates: [lng0, lat0] };
        }
        if (t === "LineString") {
            var lr = sanitizeRingCoords(geom.coordinates, 2);
            return lr ? { type: "LineString", coordinates: lr } : null;
        }
        if (t === "Polygon") {
            var pr = sanitizePolygonCoordsAllRings(geom.coordinates || []);
            return pr ? { type: "Polygon", coordinates: pr } : null;
        }
        if (t === "MultiLineString") {
            var lines = [];
            (geom.coordinates || []).forEach(function (ln) {
                var s = sanitizeRingCoords(ln, 2);
                if (s) lines.push(s);
            });
            return lines.length ? { type: "MultiLineString", coordinates: lines } : null;
        }
        if (t === "MultiPolygon") {
            var polys = [];
            (geom.coordinates || []).forEach(function (part) {
                var n = normalizeMultiPolygonPart(part);
                if (n) polys.push(n);
            });
            return polys.length ? { type: "MultiPolygon", coordinates: polys } : null;
        }
        if (t === "MultiPoint") {
            var pts = [];
            (geom.coordinates || []).forEach(function (p) {
                var g = sanitizeGeometryForTokml({ type: "Point", coordinates: p });
                if (g) pts.push(g.coordinates);
            });
            return pts.length ? { type: "MultiPoint", coordinates: pts } : null;
        }
        if (t === "GeometryCollection" && Array.isArray(geom.geometries)) {
            var gs = [];
            geom.geometries.forEach(function (g) {
                var sg = sanitizeGeometryForTokml(g);
                if (sg) gs.push(sg);
            });
            return gs.length ? { type: "GeometryCollection", geometries: gs } : null;
        }
        return null;
    }

    /**
     * tokml отбрасывает фичи с !properties (в т.ч. null или отсутствует ключ) — тогда KML пустой.
     * Плюс приводим координаты к виду, который tokml не ломает на linearring.
     */
    function normalizeFeatureCollectionForTokml(fc) {
        if (!fc || fc.type !== "FeatureCollection" || !Array.isArray(fc.features)) {
            return { type: "FeatureCollection", features: [] };
        }
        var features = [];
        fc.features.forEach(function (f) {
            var nf = JSON.parse(
                JSON.stringify(
                    f || {
                        type: "Feature",
                        properties: {},
                        geometry: null
                    }
                )
            );
            if (!nf.type) nf.type = "Feature";
            if (nf.properties == null || typeof nf.properties !== "object") nf.properties = {};
            var sg = sanitizeGeometryForTokml(nf.geometry);
            if (!sg) return;
            nf.geometry = sg;
            features.push(nf);
        });
        return { type: "FeatureCollection", features: features };
    }

    function downloadKml(featureCollection, filename) {
        var runTokml =
            typeof tokml === "function"
                ? tokml
                : typeof window !== "undefined" && typeof window.tokml === "function"
                  ? window.tokml
                  : null;
        if (!runTokml) {
            toast("Не удалось экспортировать: скрипт tokml не загрузился (сеть, блокировщик, CDN).");
            return;
        }
        try {
            var fc = normalizeFeatureCollectionForTokml(featureCollection);
            if (!fc.features.length) {
                toast("Нет объектов с корректной геометрией для экспорта (проверьте координаты).");
                return;
            }
            var kml = runTokml(fc);
            var blob = new Blob([kml], { type: "application/vnd.google-earth.kml+xml" });
            var url = URL.createObjectURL(blob);
            var a = document.createElement("a");
            a.href = url;
            a.download = filename || "export.kml";
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        } catch (err) {
            toast("Ошибка при формировании KML: " + (err && err.message ? err.message : String(err)));
        }
    }

    function safeFilename(s) {
        var t = String(s || "layer")
            .replace(/[<>:"/\\|?*\u0000-\u001F]+/g, "_")
            .trim();
        return t.slice(0, 80) || "layer";
    }

    function collectFeaturesForLogicalLayer(layerId) {
        return allEntries
            .filter(function (e) {
                return e.logicalLayerId === layerId;
            })
            .map(entryToGeoJSON);
    }

    function toast(message, actionLabel, actionFn) {
        var stack = document.getElementById("toast-stack");
        if (!stack) return;
        var t = document.createElement("div");
        t.className = "toast";
        var span = document.createElement("span");
        span.textContent = message;
        var actions = document.createElement("div");
        actions.className = "toast__actions";
        if (actionLabel && actionFn) {
            var b = document.createElement("button");
            b.type = "button";
            b.className = "btn btn--secondary";
            b.textContent = actionLabel;
            b.addEventListener("click", function () {
                actionFn();
                stack.removeChild(t);
            });
            actions.appendChild(b);
        }
        var close = document.createElement("button");
        close.type = "button";
        close.className = "btn btn--ghost";
        close.textContent = "OK";
        close.addEventListener("click", function () {
            stack.removeChild(t);
        });
        actions.appendChild(close);
        t.appendChild(span);
        t.appendChild(actions);
        stack.appendChild(t);
        if (!actionLabel) {
            setTimeout(function () {
                if (t.parentNode === stack) stack.removeChild(t);
            }, 4200);
        }
    }

    var modalEl = document.getElementById("modal");
    var modalTitle = document.getElementById("modal-title");
    var modalBody = document.getElementById("modal-body");
    var modalActions = document.getElementById("modal-actions");

    function closeModal() {
        if (modalEl) modalEl.hidden = true;
    }

    function openModal(title, bodyNode, onConfirm, confirmText) {
        modalTitle.textContent = title;
        modalBody.innerHTML = "";
        modalBody.appendChild(bodyNode);
        modalActions.innerHTML = "";
        var cancel = document.createElement("button");
        cancel.type = "button";
        cancel.className = "btn btn--ghost";
        cancel.textContent = "Отмена";
        cancel.addEventListener("click", closeModal);
        var ok = document.createElement("button");
        ok.type = "button";
        ok.className = "btn btn--primary";
        ok.textContent = confirmText || "OK";
        ok.addEventListener("click", function () {
            onConfirm();
        });
        modalActions.appendChild(cancel);
        modalActions.appendChild(ok);
        modalEl.hidden = false;
    }

    function openDrawTargetModal(feature) {
        if (!logicalLayers.length) {
            toast("Сначала создайте слой.");
            return;
        }
        var wrap = document.createElement("div");
        var p = document.createElement("p");
        p.textContent = "Добавить объект в слой";
        var sel = document.createElement("select");
        sel.className = "select";
        sel.id = "modal-draw-target-layer-" + ++formFieldUid;
        sel.name = "draw-target-layer";
        logicalLayers.forEach(function (l) {
            var o = document.createElement("option");
            o.value = l.id;
            o.textContent = l.name;
            sel.appendChild(o);
        });
        wrap.appendChild(p);
        wrap.appendChild(sel);
        openModal("Новый объект", wrap, function () {
            createFeatureEntry(feature, sel.value);
            closeModal();
        }, "Добавить");
    }

    function promptNewLayerName() {
        var wrap = document.createElement("div");
        var p = document.createElement("p");
        p.textContent = "Имя нового слоя";
        var input = document.createElement("input");
        input.type = "text";
        input.className = "modal__input";
        input.id = "modal-new-layer-" + ++formFieldUid;
        input.name = "new-layer-name";
        input.setAttribute("autocomplete", "off");
        input.placeholder = "Например, Границы участка";
        wrap.appendChild(p);
        wrap.appendChild(input);
        openModal("Новый слой", wrap, function () {
            var n = input.value.trim();
            if (n) addLogicalLayer(n);
            else addLogicalLayer(null);
            closeModal();
        }, "Создать");
        setTimeout(function () {
            input.focus();
        }, 50);
    }

    function pickTargetLayerId(title, confirmText, cb) {
        var wrap = document.createElement("div");
        var p = document.createElement("p");
        p.textContent = "Выберите слой для результата";
        var sel = document.createElement("select");
        sel.className = "select";
        sel.id = "modal-pick-layer-" + ++formFieldUid;
        sel.name = "pick-target-layer";
        logicalLayers.forEach(function (l) {
            var o = document.createElement("option");
            o.value = l.id;
            o.textContent = l.name;
            sel.appendChild(o);
        });
        wrap.appendChild(p);
        wrap.appendChild(sel);
        openModal(title, wrap, function () {
            cb(sel.value);
            closeModal();
        }, confirmText || "Применить");
    }

    function leafToJstsGeom(entry) {
        var geojson = entryToGeoJSON(entry);
        invertCoordinates(geojson);
        return jstsReader.read(geojson.geometry);
    }

    function jstsGeomToFeature(geom) {
        var feature = {
            type: "Feature",
            properties: {},
            geometry: jstsWriter.write(geom)
        };
        invertCoordinates(feature);
        return feature;
    }

    function jstsSymmetricDifference(ga, gb) {
        if (typeof ga.symDifference === "function") {
            return ga.symDifference(gb);
        }
        return ga.difference(gb).union(gb.difference(ga));
    }

    function geoJsonGeometryToJsts(geom) {
        var f = {
            type: "Feature",
            properties: {},
            geometry: JSON.parse(JSON.stringify(geom))
        };
        invertCoordinates(f);
        return jstsReader.read(f.geometry);
    }

    /** Разбить геометрию на список Polygon (MultiPolygon → части, из GeometryCollection — только полигоны). */
    function explodeToPolygons(geom) {
        var out = [];
        if (!geom) return out;
        if (geom.type === "Polygon") {
            out.push(geom);
            return out;
        }
        if (geom.type === "MultiPolygon") {
            geom.coordinates.forEach(function (ring) {
                out.push({ type: "Polygon", coordinates: ring });
            });
            return out;
        }
        if (geom.type === "GeometryCollection" && geom.geometries) {
            geom.geometries.forEach(function (g) {
                out = out.concat(explodeToPolygons(g));
            });
        }
        return out;
    }

    /** Центроид по внешнему кольцу (простое среднее), для запасной линии связи. */
    function centroidOfExteriorRingPolygon(polyGeom) {
        var ring = polyGeom && polyGeom.coordinates && polyGeom.coordinates[0];
        if (!ring || ring.length < 3) return null;
        var n = ring.length - 1;
        if (ring[0][0] !== ring[n][0] || ring[0][1] !== ring[n][1]) n = ring.length;
        if (n < 3) return null;
        var sx = 0;
        var sy = 0;
        for (var i = 0; i < n; i++) {
            sx += Number(ring[i][0]);
            sy += Number(ring[i][1]);
        }
        return [sx / n, sy / n];
    }

    function jstsNearestLngLatSegmentBetweenPolygonGeoms(polyA, polyB) {
        try {
            var j1 = geoJsonGeometryToJsts(polyA);
            var j2 = geoJsonGeometryToJsts(polyB);
            var DOp = jsts && jsts.operation && jsts.operation.distance && jsts.operation.distance.DistanceOp;
            if (typeof DOp !== "function") return null;
            var op = new DOp(j1, j2);
            var pts = op.nearestPoints();
            if (pts && pts.length >= 2 && pts[0] && pts[1]) {
                return [
                    [Number(pts[0].x), Number(pts[0].y)],
                    [Number(pts[1].x), Number(pts[1].y)]
                ];
            }
        } catch (e) {
            /* ignore */
        }
        return null;
    }

    /** Узкая «лента» между двумя точками на эллипсоиде (~м для ширины). */
    function thinBridgePolygonRingLngLat(p0, p1, halfWidthMeters) {
        var hw = Number(halfWidthMeters);
        if (!Number.isFinite(hw) || hw <= 0) return null;
        var dLng = p1[0] - p0[0];
        var dLat = p1[1] - p0[1];
        var len = Math.sqrt(dLng * dLng + dLat * dLat);
        if (len < 1e-14) return null;
        var uLng = dLng / len;
        var uLat = dLat / len;
        var midLat = (p0[1] + p1[1]) * 0.5;
        var rad = (Math.PI / 180) * midLat;
        var mPerDegLng = 111320 * Math.cos(rad);
        var mPerDegLat = 111320;
        if (mPerDegLng < 1) mPerDegLng = 1;
        var nx = (-uLat * hw) / mPerDegLng;
        var ny = (uLng * hw) / mPerDegLat;
        var a = [p0[0] + nx, p0[1] + ny];
        var b = [p1[0] + nx, p1[1] + ny];
        var c = [p1[0] - nx, p1[1] - ny];
        var d = [p0[0] - nx, p0[1] - ny];
        return [a, b, c, d, a];
    }

    /**
     * Собрать выбранные полигоны в одну фичу MultiPolygon (один placemark при экспорте).
     * Контуры идут в порядке выбора и порядка частей внутри MultiPolygon каждой фичи.
     * @param {boolean} addBridges — добавить тонкие четырёхугольные перемычки между соседними контурами
     */
    function buildLinkMergedPolygonFeature(entries, addBridges, halfWidthMeters) {
        var polys = [];
        for (var ei = 0; ei < entries.length; ei++) {
            var parts = explodeToPolygons(entries[ei].feature.geometry);
            for (var pi = 0; pi < parts.length; pi++) {
                polys.push(parts[pi]);
            }
        }
        if (polys.length < 2) return null;
        var coords = polys.map(function (p) {
            return p.coordinates;
        });
        if (addBridges) {
            var hw = halfWidthMeters == null ? 2 : Number(halfWidthMeters);
            if (!Number.isFinite(hw) || hw <= 0) hw = 2;
            for (var i = 0; i < polys.length - 1; i++) {
                var seg = jstsNearestLngLatSegmentBetweenPolygonGeoms(polys[i], polys[i + 1]);
                if (!seg) {
                    var c1 = centroidOfExteriorRingPolygon(polys[i]);
                    var c2 = centroidOfExteriorRingPolygon(polys[i + 1]);
                    if (c1 && c2) seg = [c1, c2];
                }
                if (!seg) continue;
                var ring = thinBridgePolygonRingLngLat(seg[0], seg[1], hw);
                if (ring) coords.push(ring);
            }
        }
        var props = JSON.parse(JSON.stringify(entries[0].feature.properties || {}));
        var baseName = props.name != null ? props.name : props.Name;
        props.name =
            baseName != null && String(baseName).trim()
              ? String(baseName).trim() + " (связанный набор)"
              : "Связанный набор (" + polys.length + " контуров)";
        props.mergedFromCount = entries.length;
        props.mergedPolygonParts = polys.length;
        return {
            type: "Feature",
            properties: props,
            geometry: {
                type: "MultiPolygon",
                coordinates: coords
            }
        };
    }

    /** Суммарное число отдельных полигонов у выбранных фич. */
    function countPolygonPartsInEntries(entries) {
        var n = 0;
        for (var i = 0; i < entries.length; i++) {
            if (!isPolygonalEntry(entries[i])) continue;
            n += explodeToPolygons(entries[i].feature.geometry).length;
        }
        return n;
    }

    function featureLabelForOverlap(feat, index) {
        var p = feat.properties || {};
        var n = p.name;
        if (n == null) n = p.Name;
        if (n == null) n = p.title;
        if (n != null && String(n).trim()) return String(n).trim();
        return "Объект " + (index + 1);
    }

    function polygonGeometriesFromJstsIntersection(interJsts) {
        var feat = jstsGeomToFeature(interJsts);
        return explodeToPolygons(feat.geometry);
    }

    /**
     * Наложение = есть общая 2D-область с ненулевой площадью.
     * Касание только по ребру или вершине (пересечение — линия/точка) не считается.
     */
    function jstsIntersectionHasPositiveOverlapArea(interJsts, minArea) {
        minArea = minArea == null ? 1e-16 : minArea;
        if (!interJsts || interJsts.isEmpty()) return false;
        if (typeof interJsts.getDimension !== "function" || interJsts.getDimension() < 2) return false;
        if (typeof interJsts.getArea !== "function") return false;
        return interJsts.getArea() > minArea;
    }

    function addResultFeature(feature, targetLayerId) {
        importGeoJSONToLayer(feature, targetLayerId);
        fitMapToEntries(allEntries);
    }

    function clearSelection() {
        vertexDragState = null;
        featureBodyDragState = null;
        resetMapDragSuppression();
        selectedOrder.forEach(function (e) {
            setSelected(e, false);
        });
        selectedOrder = [];
        updateSelectionBadge();
    }

    function removeLayerFromData(entry) {
        removeEntryFromParent(entry);
        var stash = hiddenStash.get(entry.logicalLayerId);
        if (stash) {
            var ix = stash.indexOf(entry);
            if (ix !== -1) stash.splice(ix, 1);
        }
    }

    /**
     * @param {FileList|File[]} fileList
     * @param {string|null|undefined} explicitTargetLayerId — если задан, импорт в этот слой; иначе значение селекта «Импорт KML»
     * @param {HTMLInputElement|null} inputToReset — сброс value у input[type=file]
     */
    function processKmlFiles(fileList, explicitTargetLayerId, inputToReset) {
        if (!logicalLayers.length) {
            toast("Сначала создайте слой.");
            return;
        }
        var targetId =
            explicitTargetLayerId != null && String(explicitTargetLayerId) !== ""
                ? String(explicitTargetLayerId)
                : (function () {
                      var sel = document.getElementById("import-target-layer");
                      return sel ? sel.value : "";
                  })();
        if (!targetId || !layerById(targetId)) {
            toast("Слой для импорта не найден.");
            return;
        }
        var files = Array.prototype.slice.call(fileList).filter(function (f) {
            return /\.kml$/i.test(f.name) || f.type.indexOf("xml") !== -1 || f.type.indexOf("kml") !== -1;
        });
        if (!files.length) {
            toast("Нет KML файлов в выборе.");
            return;
        }
        var remaining = files.length;
        var combined = null;
        files.forEach(function (file) {
            var fr = new FileReader();
            fr.onload = function () {
                try {
                    var text = fr.result;
                    var parser = new DOMParser();
                    var kml = parser.parseFromString(text, "text/xml");
                    var geojson = toGeoJSON.kml(kml);
                    var created = importGeoJSONToLayer(geojson, targetId);
                    created.forEach(function (e) {
                        var bb = bboxFromGeometry(e.feature.geometry);
                        if (bb) {
                            combined = combined
                                ? {
                                      minLng: Math.min(combined.minLng, bb.minLng),
                                      maxLng: Math.max(combined.maxLng, bb.maxLng),
                                      minLat: Math.min(combined.minLat, bb.minLat),
                                      maxLat: Math.max(combined.maxLat, bb.maxLat)
                                  }
                                : bb;
                        }
                    });
                } catch (err) {
                    toast("Ошибка разбора: " + file.name);
                }
                remaining -= 1;
                if (remaining === 0 && combined) fitMapToBBox(combined);
            };
            fr.readAsText(file);
        });
        toast("Импорт: " + files.length + " файл(ов).");
        if (inputToReset && "value" in inputToReset) {
            inputToReset.value = "";
        }
    }

    var compareMapA = null;
    var compareMapB = null;
    var compareFeaturesA = [];
    var compareFeaturesB = [];
    var compareSyncLock = false;
    var compareMapsReady = false;
    var compareBboxA = null;
    var compareBboxB = null;
    var compareSplitPct = 50;

    function mergeBBox(a, b) {
        if (!a) return b || null;
        if (!b) return a;
        return {
            minLng: Math.min(a.minLng, b.minLng),
            maxLng: Math.max(a.maxLng, b.maxLng),
            minLat: Math.min(a.minLat, b.minLat),
            maxLat: Math.max(a.maxLat, b.maxLat)
        };
    }

    function compareFitBounds() {
        var merged = mergeBBox(compareBboxA, compareBboxB);
        if (!merged || !compareMapA || !compareMapB) return;
        compareSyncLock = true;
        try {
            var req = {
                bounds: [
                    [merged.minLng, merged.minLat],
                    [merged.maxLng, merged.maxLat]
                ],
                duration: 320
            };
            compareMapA.setLocation(req);
            compareMapB.setLocation(req);
        } catch (e) {
            /* ignore */
        }
        requestAnimationFrame(function () {
            compareSyncLock = false;
        });
    }

    /** Дождаться размеров контейнера после снятия display:none — иначе YMap инициализируется с нулём и ничего не рисуется. */
    function waitForNonZeroSize(el, maxFrames) {
        maxFrames = maxFrames == null ? 48 : maxFrames;
        return new Promise(function (resolve) {
            var frame = 0;
            function tick() {
                if (!el || (el.clientWidth >= 2 && el.clientHeight >= 2)) {
                    resolve();
                    return;
                }
                frame++;
                if (frame >= maxFrames) {
                    resolve();
                    return;
                }
                requestAnimationFrame(tick);
            }
            tick();
        });
    }

    async function ensureCompareMaps() {
        if (compareMapsReady) return;
        if (typeof ymaps3 === "undefined") {
            throw new Error("Карта не загружена. Проверьте ключ в config.js.");
        }
        await ymaps3.ready;
        var YMap = ymaps3.YMap;
        var YMapDefaultSchemeLayer = ymaps3.YMapDefaultSchemeLayer;
        var YMapDefaultFeaturesLayer = ymaps3.YMapDefaultFeaturesLayer;
        var YMapListener = ymaps3.YMapListener;
        var elA = document.getElementById("compare-map-a");
        var elB = document.getElementById("compare-map-b");
        if (!elA || !elB) {
            throw new Error("Нет контейнеров сравнения.");
        }
        var stack = document.getElementById("compare-stack");
        await waitForNonZeroSize(stack || elA);
        var loc = { center: [37.618423, 55.751244], zoom: 5 };
        compareMapA = new YMap(
            elA,
            { location: loc },
            [new YMapDefaultSchemeLayer({}), new YMapDefaultFeaturesLayer({})]
        );
        compareMapB = new YMap(
            elB,
            { location: loc },
            [new YMapDefaultSchemeLayer({}), new YMapDefaultFeaturesLayer({})]
        );
        function syncTo(peer, payload) {
            if (compareSyncLock || !payload || !payload.location) return;
            var L = payload.location;
            if (typeof L.zoom !== "number" || !L.center) return;
            compareSyncLock = true;
            try {
                peer.setLocation({
                    center: L.center,
                    zoom: L.zoom,
                    duration: 0
                });
            } catch (e) {
                /* ignore */
            }
            requestAnimationFrame(function () {
                compareSyncLock = false;
            });
        }
        compareMapA.addChild(
            new YMapListener({
                onUpdate: function (payload) {
                    syncTo(compareMapB, payload);
                }
            })
        );
        compareMapB.addChild(
            new YMapListener({
                onUpdate: function (payload) {
                    syncTo(compareMapA, payload);
                }
            })
        );
        compareMapsReady = true;
    }

    function clearCompareSide(side) {
        var m = side === "a" ? compareMapA : compareMapB;
        var arr = side === "a" ? compareFeaturesA : compareFeaturesB;
        if (!m) return;
        arr.forEach(function (f) {
            try {
                m.removeChild(f);
            } catch (e) {
                /* ignore */
            }
        });
        arr.length = 0;
        if (side === "a") compareBboxA = null;
        else compareBboxB = null;
    }

    function bboxFromFeatureParts(parts) {
        var b = null;
        parts.forEach(function (feat) {
            var bb = bboxFromGeometry(feat.geometry);
            if (bb) {
                b = b
                    ? {
                          minLng: Math.min(b.minLng, bb.minLng),
                          maxLng: Math.max(b.maxLng, bb.maxLng),
                          minLat: Math.min(b.minLat, bb.minLat),
                          maxLat: Math.max(b.maxLat, bb.maxLat)
                      }
                    : bb;
            }
        });
        return b;
    }

    function applyKmlToCompareSide(file, side) {
        if (!file || !compareMapA || !compareMapB) return;
        var m = side === "a" ? compareMapA : compareMapB;
        var arr = side === "a" ? compareFeaturesA : compareFeaturesB;
        var fr = new FileReader();
        fr.onload = function () {
            try {
                var kml = new DOMParser().parseFromString(fr.result, "text/xml");
                var geojson = toGeoJSON.kml(kml);
                var parts = expandGeoJSONToFeatures(geojson);
                if (!parts.length) {
                    toast("В KML нет геометрии.");
                    return;
                }
                var color = side === "a" ? "#00e5ff" : "#ffb020";
                arr.forEach(function (f) {
                    try {
                        m.removeChild(f);
                    } catch (e) {
                        /* ignore */
                    }
                });
                arr.length = 0;
                parts.forEach(function (feat) {
                    var g = feat.geometry;
                    if (!g) return;
                    var st = hexToYmapStyle(color, g.type, false);
                    var yf = new YMapFeature({
                        geometry: JSON.parse(JSON.stringify(g)),
                        style: st
                    });
                    m.addChild(yf);
                    arr.push(yf);
                });
                if (side === "a") compareBboxA = bboxFromFeatureParts(parts);
                else compareBboxB = bboxFromFeatureParts(parts);
                compareFitBounds();
            } catch (err) {
                toast("Ошибка разбора KML.");
            }
        };
        fr.readAsText(file);
    }

    var overlapMap = null;
    var overlapFeaturesBase = [];
    var overlapFeaturesHits = [];
    var overlapMapReady = false;
    var overlapLastHitCollection = null;
    var OVERLAP_BASE_HEX = "#3d8bfd";
    var OVERLAP_HIT_HEX = "#f14b5c";
    /** Порог площади пересечения (кв. градусов), ниже — шум / касание на численной сетке. */
    var OVERLAP_MIN_AREA_SQ_DEG = 1e-16;

    function overlapStyleSources(geomType) {
        return hexToYmapStyle(OVERLAP_BASE_HEX, geomType, false);
    }

    function overlapStyleHits(geomType) {
        var st = hexToYmapStyle(OVERLAP_HIT_HEX, geomType, false);
        if (st.stroke && st.stroke[0]) {
            st.stroke[0].width = Math.max(3, st.stroke[0].width || 2);
        }
        return st;
    }

    function overlapStyleHitsFocused(geomType) {
        var t = geomType === "MultiPolygon" ? "Polygon" : geomType;
        if (t === "Point" || t === "MultiPoint") {
            return hexToYmapStyle("#ffd60a", geomType, true);
        }
        return {
            stroke: [{ color: "#ffea00dd", width: 5 }],
            fill: "#ffd60a66"
        };
    }

    function resetOverlapHitStyles() {
        overlapFeaturesHits.forEach(function (yf) {
            if (!yf || !yf.update) return;
            var g = yf.geometry;
            var t = g && g.type ? g.type : "Polygon";
            try {
                yf.update({ style: overlapStyleHits(t === "MultiPolygon" ? "Polygon" : t) });
            } catch (e) {
                /* ignore */
            }
        });
    }

    function expandOverlapBBoxForFocus(b, margin) {
        margin = margin == null ? 0.14 : margin;
        var lngSpan = b.maxLng - b.minLng;
        var latSpan = b.maxLat - b.minLat;
        var padLng = lngSpan > 1e-9 ? lngSpan * margin : 0.0012;
        var padLat = latSpan > 1e-9 ? latSpan * margin : 0.0012;
        return {
            minLng: b.minLng - padLng,
            maxLng: b.maxLng + padLng,
            minLat: b.minLat - padLat,
            maxLat: b.maxLat + padLat
        };
    }

    function focusOverlapHitByIndex(i) {
        if (i < 0 || i >= overlapFeaturesHits.length || !overlapLastHitCollection) return;
        resetOverlapHitStyles();
        var yf = overlapFeaturesHits[i];
        var gj = overlapLastHitCollection[i];
        if (yf && yf.update) {
            var gt = yf.geometry && yf.geometry.type ? yf.geometry.type : "Polygon";
            try {
                yf.update({ style: overlapStyleHitsFocused(gt) });
            } catch (e) {
                /* ignore */
            }
        }
        if (gj && gj.geometry) {
            var bb = bboxFromGeometry(gj.geometry);
            if (bb) fitOverlapMapToBBox(expandOverlapBBoxForFocus(bb));
        }
        var list = document.getElementById("overlap-hit-list");
        if (list) {
            list.querySelectorAll(".overlap-hit-item").forEach(function (btn) {
                var idx = parseInt(btn.getAttribute("data-hit-index"), 10);
                btn.classList.toggle("is-active", idx === i);
            });
        }
        setTimeout(function () {
            window.dispatchEvent(new Event("resize"));
        }, 50);
    }

    function rebuildOverlapHitList(featuresGeo) {
        var ul = document.getElementById("overlap-hit-list");
        var empty = document.getElementById("overlap-list-empty");
        if (!ul) return;
        ul.innerHTML = "";
        if (!featuresGeo || featuresGeo.length === 0) {
            if (empty) empty.hidden = false;
            return;
        }
        if (empty) empty.hidden = true;
        featuresGeo.forEach(function (feat, idx) {
            var name =
                feat.properties && feat.properties.name
                    ? feat.properties.name
                    : "Пересечение " + (idx + 1);
            var li = document.createElement("li");
            var btn = document.createElement("button");
            btn.type = "button";
            btn.className = "overlap-hit-item";
            btn.setAttribute("data-hit-index", String(idx));
            btn.setAttribute("role", "option");
            btn.textContent = name;
            li.appendChild(btn);
            ul.appendChild(li);
        });
    }

    function initOverlapHitListOnce() {
        var ul = document.getElementById("overlap-hit-list");
        if (!ul || ul.getAttribute("data-bound") === "1") return;
        ul.setAttribute("data-bound", "1");
        ul.addEventListener("click", function (ev) {
            var btn = ev.target.closest(".overlap-hit-item");
            if (!btn || !ul.contains(btn)) return;
            var idx = parseInt(btn.getAttribute("data-hit-index"), 10);
            if (!isNaN(idx)) focusOverlapHitByIndex(idx);
        });
    }

    function overlapStyleHidden() {
        return {
            stroke: [{ color: "rgba(0,0,0,0)", width: 0 }],
            fill: "rgba(0,0,0,0)"
        };
    }

    function refreshOverlapSourceVisibility() {
        var cb = document.getElementById("overlap-show-sources");
        var show = !cb || cb.checked;
        var hiddenSt = overlapStyleHidden();
        overlapFeaturesBase.forEach(function (yf) {
            if (!yf || !yf.update) return;
            var g = yf.geometry;
            var t = g ? g.type : "Polygon";
            try {
                yf.update({ style: show ? overlapStyleSources(t) : hiddenSt });
            } catch (e) {
                /* ignore */
            }
        });
    }

    function clearOverlapMapLayers() {
        if (!overlapMap) return;
        overlapFeaturesBase.concat(overlapFeaturesHits).forEach(function (yf) {
            try {
                overlapMap.removeChild(yf);
            } catch (e) {
                /* ignore */
            }
        });
        overlapFeaturesBase = [];
        overlapFeaturesHits = [];
        overlapLastHitCollection = null;
        rebuildOverlapHitList([]);
        var dl = document.getElementById("overlap-download-btn");
        if (dl) dl.disabled = true;
        var st = document.getElementById("overlap-status");
        if (st) st.textContent = "Загрузите KML и нажмите «Найти пересечения»";
    }

    function fitOverlapMapToBBox(b) {
        if (!b || !overlapMap || !overlapMap.setLocation) return;
        try {
            overlapMap.setLocation({
                bounds: [
                    [b.minLng, b.minLat],
                    [b.maxLng, b.maxLat]
                ],
                duration: 280
            });
        } catch (e) {
            /* ignore */
        }
    }

    function fitOverlapMapToCurrentLayers() {
        var mergedB = null;
        overlapFeaturesBase.concat(overlapFeaturesHits).forEach(function (yf) {
            var g = yf && yf.geometry;
            if (!g) return;
            var bb = bboxFromGeometry(g);
            if (!bb) return;
            mergedB = mergedB
                ? {
                      minLng: Math.min(mergedB.minLng, bb.minLng),
                      maxLng: Math.max(mergedB.maxLng, bb.maxLng),
                      minLat: Math.min(mergedB.minLat, bb.minLat),
                      maxLat: Math.max(mergedB.maxLat, bb.maxLat)
                  }
                : bb;
        });
        if (mergedB) fitOverlapMapToBBox(mergedB);
    }

    async function ensureOverlapMap() {
        if (overlapMapReady) return;
        if (typeof ymaps3 === "undefined") {
            throw new Error("Карта не загружена. Проверьте ключ в config.js.");
        }
        await ymaps3.ready;
        var YMap = ymaps3.YMap;
        var YMapDefaultSchemeLayer = ymaps3.YMapDefaultSchemeLayer;
        var YMapDefaultFeaturesLayer = ymaps3.YMapDefaultFeaturesLayer;
        var el = document.getElementById("overlap-map");
        if (!el) throw new Error("Нет контейнера карты пересечений.");
        await waitForNonZeroSize(el);
        overlapMap = new YMap(
            el,
            {
                location: {
                    center: [37.618423, 55.751244],
                    zoom: 5
                }
            },
            [new YMapDefaultSchemeLayer({}), new YMapDefaultFeaturesLayer({})]
        );
        overlapMapReady = true;
    }

    function runOverlapAnalysisFromFile(file, statusEl) {
        ensureOverlapMap()
            .then(function () {
                var fr = new FileReader();
                fr.onload = function () {
                    try {
                        var kml = new DOMParser().parseFromString(fr.result, "text/xml");
                        var geojson = toGeoJSON.kml(kml);
                        var rawParts = expandGeoJSONToFeatures(geojson);
                        var polygonal = rawParts.filter(function (f) {
                            return f.geometry && isPolygonalGeometry(f.geometry);
                        });
                        if (polygonal.length < 2) {
                            clearOverlapMapLayers();
                            if (statusEl)
                                statusEl.textContent = "Нужно минимум два полигона (Polygon / MultiPolygon) в файле.";
                            toast("В KML меньше двух полигонов для анализа.");
                            return;
                        }
                        if (polygonal.length > 75) {
                            if (
                                !confirm(
                                    "Объектов много (" +
                                        polygonal.length +
                                        "). Сравнение всех пар может занять время. Продолжить?"
                                )
                            ) {
                                if (statusEl) statusEl.textContent = "Анализ отменён.";
                                return;
                            }
                        }
                        clearOverlapMapLayers();
                        var inputs = [];
                        for (var idx = 0; idx < polygonal.length; idx++) {
                            (function (i) {
                                var feat = polygonal[i];
                                try {
                                    var jg = geoJsonGeometryToJsts(feat.geometry);
                                    if (jg.isEmpty()) return;
                                    inputs.push({
                                        feature: feat,
                                        label: featureLabelForOverlap(feat, i),
                                        jsts: jg,
                                        index: i
                                    });
                                } catch (e) {
                                    /* skip bad geom */
                                }
                            })(idx);
                        }
                        if (inputs.length < 2) {
                            if (statusEl)
                                statusEl.textContent = "Не удалось прочитать геометрию полигонов.";
                            toast("Ошибка геометрии полигонов.");
                            return;
                        }
                        inputs.forEach(function (item) {
                            var g = item.feature.geometry;
                            var st = overlapStyleSources(g.type);
                            var yf = new YMapFeature({
                                geometry: JSON.parse(JSON.stringify(g)),
                                style: st
                            });
                            overlapMap.addChild(yf);
                            overlapFeaturesBase.push(yf);
                        });
                        refreshOverlapSourceVisibility();
                        var hitFeaturesGeo = [];
                        var hitCount = 0;
                        for (var i = 0; i < inputs.length; i++) {
                            for (var j = i + 1; j < inputs.length; j++) {
                                try {
                                    var inter = inputs[i].jsts.intersection(inputs[j].jsts);
                                    if (!jstsIntersectionHasPositiveOverlapArea(inter, OVERLAP_MIN_AREA_SQ_DEG))
                                        continue;
                                    var polys = polygonGeometriesFromJstsIntersection(inter);
                                    if (!polys.length) continue;
                                    polys = polys.filter(function (poly) {
                                        try {
                                            var jg = geoJsonGeometryToJsts(poly);
                                            return (
                                                jg &&
                                                typeof jg.getArea === "function" &&
                                                jg.getArea() > OVERLAP_MIN_AREA_SQ_DEG
                                            );
                                        } catch (e2) {
                                            return false;
                                        }
                                    });
                                    if (!polys.length) continue;
                                    hitCount++;
                                    var labelA = inputs[i].label;
                                    var labelB = inputs[j].label;
                                    polys.forEach(function (polyGeom, pi) {
                                        var props = {
                                            name:
                                                "Пересечение: " +
                                                labelA +
                                                " × " +
                                                labelB +
                                                (polys.length > 1 ? " · часть " + (pi + 1) : ""),
                                            overlapPair: labelA + " | " + labelB
                                        };
                                        var gjFeat = {
                                            type: "Feature",
                                            properties: props,
                                            geometry: polyGeom
                                        };
                                        hitFeaturesGeo.push(gjFeat);
                                        var yfHit = new YMapFeature({
                                            geometry: JSON.parse(JSON.stringify(polyGeom)),
                                            style: overlapStyleHits("Polygon")
                                        });
                                        overlapMap.addChild(yfHit);
                                        overlapFeaturesHits.push(yfHit);
                                    });
                                } catch (e) {
                                    /* ignore pair */
                                }
                            }
                        }
                        overlapLastHitCollection = hitFeaturesGeo;
                        var dlBtn = document.getElementById("overlap-download-btn");
                        if (dlBtn) dlBtn.disabled = hitFeaturesGeo.length === 0;
                        var mergedB = null;
                        polygonal.forEach(function (f) {
                            var bb = bboxFromGeometry(f.geometry);
                            if (bb) {
                                mergedB = mergedB
                                    ? {
                                          minLng: Math.min(mergedB.minLng, bb.minLng),
                                          maxLng: Math.max(mergedB.maxLng, bb.maxLng),
                                          minLat: Math.min(mergedB.minLat, bb.minLat),
                                          maxLat: Math.max(mergedB.maxLat, bb.maxLat)
                                      }
                                    : bb;
                            }
                        });
                        if (mergedB) fitOverlapMapToBBox(mergedB);
                        rebuildOverlapHitList(hitFeaturesGeo);
                        setTimeout(function () {
                            window.dispatchEvent(new Event("resize"));
                        }, 60);
                        var msg =
                            hitCount === 0
                                ? "Пересечений с площадью не найдено (пары " +
                                  inputs.length +
                                  " полигонов)."
                                : "Найдено пересечений: " +
                                  hitCount +
                                  " пар → " +
                                  hitFeaturesGeo.length +
                                  " площадей на карте (красные).";
                        if (statusEl) statusEl.textContent = msg;
                        toast(hitCount === 0 ? "Наложений с площадью нет." : "Готово: " + hitCount + " пар.");
                    } catch (err) {
                        if (statusEl) statusEl.textContent = "Ошибка разбора KML.";
                        toast("Ошибка разбора KML.");
                    }
                };
                fr.readAsText(file);
            })
            .catch(function (err) {
                toast(err && err.message ? err.message : "Карта недоступна.");
            });
    }

    function setAppMode(mode) {
        var viewEd = document.getElementById("view-editor");
        var viewCo = document.getElementById("view-compare");
        var viewOv = document.getElementById("view-overlap");
        var tabEd = document.getElementById("mode-tab-editor");
        var tabCo = document.getElementById("mode-tab-compare");
        var tabOv = document.getElementById("mode-tab-overlap");
        if (!viewEd || !viewCo || !viewOv) return;
        var isEd = mode === "editor";
        var isCo = mode === "compare";
        var isOv = mode === "overlap";
        viewEd.hidden = !isEd;
        viewCo.hidden = !isCo;
        viewOv.hidden = !isOv;
        viewEd.setAttribute("aria-hidden", isEd ? "false" : "true");
        viewCo.setAttribute("aria-hidden", isCo ? "false" : "true");
        viewOv.setAttribute("aria-hidden", isOv ? "false" : "true");
        document.body.classList.toggle("mode-compare", isCo);
        document.body.classList.toggle("mode-overlap", isOv);
        if (tabEd) {
            tabEd.classList.toggle("is-active", isEd);
            tabEd.setAttribute("aria-selected", isEd ? "true" : "false");
        }
        if (tabCo) {
            tabCo.classList.toggle("is-active", isCo);
            tabCo.setAttribute("aria-selected", isCo ? "true" : "false");
        }
        if (tabOv) {
            tabOv.classList.toggle("is-active", isOv);
            tabOv.setAttribute("aria-selected", isOv ? "true" : "false");
        }
        setTimeout(function () {
            window.dispatchEvent(new Event("resize"));
        }, 180);
    }

    function wireCompareSplitter() {
        var stack = document.getElementById("compare-stack");
        var split = document.getElementById("compare-splitter");
        if (!stack || !split || split.getAttribute("data-bound") === "1") return;
        split.setAttribute("data-bound", "1");
        function setSplitPct(pct) {
            compareSplitPct = Math.max(6, Math.min(94, pct));
            stack.style.setProperty("--compare-split", compareSplitPct + "%");
            split.setAttribute("aria-valuenow", String(Math.round(compareSplitPct)));
        }
        function onPointerMove(ev, rect) {
            var x = ev.clientX - rect.left;
            setSplitPct((x / rect.width) * 100);
        }
        split.addEventListener("pointerdown", function (down) {
            down.preventDefault();
            var rect = stack.getBoundingClientRect();
            try {
                split.setPointerCapture(down.pointerId);
            } catch (e) {
                /* ignore */
            }
            onPointerMove(down, rect);
            function move(ev) {
                onPointerMove(ev, stack.getBoundingClientRect());
            }
            function up() {
                try {
                    split.releasePointerCapture(down.pointerId);
                } catch (e2) {
                    /* ignore */
                }
                split.removeEventListener("pointermove", move);
                split.removeEventListener("pointerup", up);
                split.removeEventListener("pointercancel", up);
            }
            split.addEventListener("pointermove", move);
            split.addEventListener("pointerup", up);
            split.addEventListener("pointercancel", up);
        });
        split.addEventListener("keydown", function (ev) {
            if (ev.key === "ArrowLeft") {
                ev.preventDefault();
                setSplitPct(compareSplitPct - 2);
            } else if (ev.key === "ArrowRight") {
                ev.preventDefault();
                setSplitPct(compareSplitPct + 2);
            }
        });
    }

    function wireOverlapControls() {
        var analyzeBtn = document.getElementById("overlap-analyze-btn");
        var overlapFile = document.getElementById("overlap-file");
        var statusEl = document.getElementById("overlap-status");
        if (analyzeBtn && analyzeBtn.getAttribute("data-bound") !== "1") {
            analyzeBtn.setAttribute("data-bound", "1");
            analyzeBtn.addEventListener("click", function () {
                if (!overlapFile || !overlapFile.files || !overlapFile.files[0]) {
                    toast("Выберите файл KML.");
                    return;
                }
                runOverlapAnalysisFromFile(overlapFile.files[0], statusEl);
            });
        }
        var fitOvBtn = document.getElementById("overlap-fit-btn");
        if (fitOvBtn && fitOvBtn.getAttribute("data-bound") !== "1") {
            fitOvBtn.setAttribute("data-bound", "1");
            fitOvBtn.addEventListener("click", function () {
                ensureOverlapMap()
                    .then(function () {
                        fitOverlapMapToCurrentLayers();
                    })
                    .catch(function (err) {
                        toast(err && err.message ? err.message : "Карта недоступна.");
                    });
            });
        }
        var clearOvBtn = document.getElementById("overlap-clear-btn");
        if (clearOvBtn && clearOvBtn.getAttribute("data-bound") !== "1") {
            clearOvBtn.setAttribute("data-bound", "1");
            clearOvBtn.addEventListener("click", function () {
                clearOverlapMapLayers();
            });
        }
        var dlOvBtn = document.getElementById("overlap-download-btn");
        if (dlOvBtn && dlOvBtn.getAttribute("data-bound") !== "1") {
            dlOvBtn.setAttribute("data-bound", "1");
            dlOvBtn.addEventListener("click", function () {
                if (!overlapLastHitCollection || overlapLastHitCollection.length === 0) {
                    toast("Нет пересечений для сохранения.");
                    return;
                }
                downloadKml(
                    { type: "FeatureCollection", features: overlapLastHitCollection },
                    "kml-polygon-overlaps.kml"
                );
            });
        }
        var showSrc = document.getElementById("overlap-show-sources");
        if (showSrc && showSrc.getAttribute("data-bound") !== "1") {
            showSrc.setAttribute("data-bound", "1");
            showSrc.addEventListener("change", refreshOverlapSourceVisibility);
        }
        initOverlapHitListOnce();
    }

    function initCompareModeBindings() {
        var tabEd = document.getElementById("mode-tab-editor");
        var tabCo = document.getElementById("mode-tab-compare");
        var tabOv = document.getElementById("mode-tab-overlap");
        if (tabEd && tabEd.getAttribute("data-mode-bound") !== "1") {
            tabEd.setAttribute("data-mode-bound", "1");
            tabEd.addEventListener("click", function () {
                setAppMode("editor");
            });
        }
        if (tabCo && tabCo.getAttribute("data-mode-bound") !== "1") {
            tabCo.setAttribute("data-mode-bound", "1");
            tabCo.addEventListener("click", function () {
                setAppMode("compare");
                ensureCompareMaps()
                    .then(function () {
                        setTimeout(function () {
                            window.dispatchEvent(new Event("resize"));
                        }, 80);
                    })
                    .catch(function (err) {
                        toast(
                            err && err.message ? err.message : "Не удалось открыть режим сравнения."
                        );
                    });
            });
        }
        if (tabOv && tabOv.getAttribute("data-mode-bound") !== "1") {
            tabOv.setAttribute("data-mode-bound", "1");
            tabOv.addEventListener("click", function () {
                setAppMode("overlap");
                ensureOverlapMap()
                    .then(function () {
                        setTimeout(function () {
                            window.dispatchEvent(new Event("resize"));
                        }, 80);
                    })
                    .catch(function (err) {
                        toast(
                            err && err.message ? err.message : "Не удалось открыть режим пересечений."
                        );
                    });
            });
        }
        wireCompareSplitter();

        function bindFileInput(el, side) {
            if (!el || el.getAttribute("data-bound") === "1") return;
            el.setAttribute("data-bound", "1");
            el.addEventListener("change", function () {
                if (!el.files || !el.files[0]) return;
                var file = el.files[0];
                ensureCompareMaps()
                    .then(function () {
                        applyKmlToCompareSide(file, side);
                        el.value = "";
                    })
                    .catch(function (err) {
                        toast(err && err.message ? err.message : "Ошибка карты.");
                        el.value = "";
                    });
            });
        }
        bindFileInput(document.getElementById("compare-file-a"), "a");
        bindFileInput(document.getElementById("compare-file-b"), "b");

        var fitBtn = document.getElementById("compare-fit-btn");
        if (fitBtn && fitBtn.getAttribute("data-bound") !== "1") {
            fitBtn.setAttribute("data-bound", "1");
            fitBtn.addEventListener("click", function () {
                compareFitBounds();
            });
        }
        var ca = document.getElementById("compare-clear-a");
        var cb = document.getElementById("compare-clear-b");
        if (ca && ca.getAttribute("data-bound") !== "1") {
            ca.setAttribute("data-bound", "1");
            ca.addEventListener("click", function () {
                clearCompareSide("a");
            });
        }
        if (cb && cb.getAttribute("data-bound") !== "1") {
            cb.setAttribute("data-bound", "1");
            cb.addEventListener("click", function () {
                clearCompareSide("b");
            });
        }
        wireOverlapControls();
    }

    function bindUi() {
        document.querySelectorAll("[data-close-modal]").forEach(function (el) {
            el.addEventListener("click", closeModal);
        });

        document.getElementById("add-layer-btn").addEventListener("click", promptNewLayerName);

        document.getElementById("sidebar-toggle").addEventListener("click", function () {
            var sb = document.getElementById("sidebar");
            var btn = document.getElementById("sidebar-toggle");
            var glyph = btn.querySelector(".icon-btn__glyph");
            sb.classList.toggle("is-collapsed");
            var collapsed = sb.classList.contains("is-collapsed");
            btn.setAttribute("aria-expanded", collapsed ? "false" : "true");
            btn.title = collapsed ? "Развернуть панель слоёв" : "Свернуть панель слоёв";
            if (glyph) glyph.textContent = collapsed ? "▶" : "◀";
        });

        var fileInput = document.getElementById("file-input");
        var drop = document.querySelector(".file-drop");
        if (drop && fileInput) {
            drop.addEventListener("click", function () {
                fileInput.click();
            });
            ["dragenter", "dragover"].forEach(function (ev) {
                drop.addEventListener(ev, function (e) {
                    e.preventDefault();
                    drop.classList.add("is-drag");
                });
            });
            ["dragleave", "drop"].forEach(function (ev) {
                drop.addEventListener(ev, function (e) {
                    e.preventDefault();
                    drop.classList.remove("is-drag");
                });
            });
            drop.addEventListener("drop", function (e) {
                var files = e.dataTransfer && e.dataTransfer.files;
                if (files && files.length) processKmlFiles(files, null, fileInput);
            });
        }

        var layerListRoot = document.getElementById("layer-list");
        if (layerListRoot) {
            layerListRoot.addEventListener("change", function (e) {
                var inp = e.target;
                if (!inp || !inp.getAttribute || !inp.hasAttribute("data-layer-kml-input")) return;
                if (!inp.files || !inp.files.length) return;
                var lid = inp.getAttribute("data-layer-kml-input");
                processKmlFiles(inp.files, lid, inp);
            });
            layerListRoot.addEventListener("dragenter", function (e) {
                var z = e.target.closest(".file-drop--in-layer");
                if (!z) return;
                e.preventDefault();
                z.classList.add("is-drag");
            });
            layerListRoot.addEventListener("dragover", function (e) {
                var z = e.target.closest(".file-drop--in-layer");
                if (!z) return;
                e.preventDefault();
                try {
                    e.dataTransfer.dropEffect = "copy";
                } catch (err) {
                    /* ignore */
                }
                z.classList.add("is-drag");
            });
            layerListRoot.addEventListener("dragleave", function (e) {
                var z = e.target.closest(".file-drop--in-layer");
                if (!z) return;
                var rel = e.relatedTarget;
                if (!rel || !z.contains(rel)) {
                    z.classList.remove("is-drag");
                }
            });
            layerListRoot.addEventListener("drop", function (e) {
                var z = e.target.closest(".file-drop--in-layer");
                if (!z) return;
                e.preventDefault();
                e.stopPropagation();
                z.classList.remove("is-drag");
                var lid = z.getAttribute("data-layer-import-id");
                var files = e.dataTransfer && e.dataTransfer.files;
                if (!files || !files.length || !lid) return;
                var inp = z.querySelector('input[type="file"]');
                processKmlFiles(files, lid, inp || null);
            });
        }

        if (fileInput) {
            fileInput.addEventListener("change", function (e) {
                if (e.target.files && e.target.files.length) {
                    processKmlFiles(e.target.files, null, fileInput);
                }
            });
        }

        document.getElementById("export-all-btn").addEventListener("click", function () {
            var features = getAllFeatures();
            if (!features.length) {
                toast("Нет объектов для экспорта.");
                return;
            }
            downloadKml({ type: "FeatureCollection", features: features }, "project.kml");
        });

        document.getElementById("export-selected-btn").addEventListener("click", function () {
            if (!selectedOrder.length) {
                toast("Выберите объекты на карте.");
                return;
            }
            var features = selectedOrder.map(entryToGeoJSON);
            downloadKml({ type: "FeatureCollection", features: features }, "selection.kml");
        });

        document.getElementById("export-by-layer-btn").addEventListener("click", function () {
            logicalLayers.forEach(function (def, i) {
                var feats = collectFeaturesForLogicalLayer(def.id);
                if (!feats.length) return;
                setTimeout(function () {
                    downloadKml({ type: "FeatureCollection", features: feats }, safeFilename(def.name) + ".kml");
                }, i * 350);
            });
            toast("Запущена серия загрузок по слоям.");
        });

        var linkPolyBtn = document.getElementById("link-polygons-btn");
        if (linkPolyBtn) linkPolyBtn.addEventListener("click", function () {
            var poly = selectedOrder.filter(isPolygonalEntry).slice();
            var nParts = countPolygonPartsInEntries(poly);
            if (!poly.length || nParts < 2) {
                toast(
                    "Выберите полигоны: всего не меньше двух контуров (несколько объектов и/или один MultiPolygon с несколькими частями)."
                );
                return;
            }
            var wrap = document.createElement("div");
            var p = document.createElement("p");
            p.textContent =
                "Один объект MultiPolygon из " +
                nParts +
                " контур(ов) (" +
                poly.length +
                " фич в выборе). Экспорт в KML — один placemark. Текущие выбранные объекты будут удалены (геометрия переносится в новый объект).";
            var lab = document.createElement("label");
            lab.className = "field";
            var chk = document.createElement("input");
            chk.type = "checkbox";
            chk.checked = true;
            chk.id = "modal-link-bridges-" + ++formFieldUid;
            var sp = document.createElement("span");
            sp.textContent =
                " Тонкие перемычки между соседними контурами (порядок: как в списке выбора, затем части внутри каждого объекта)";
            lab.appendChild(chk);
            lab.appendChild(sp);
            var lab2 = document.createElement("label");
            lab2.className = "field";
            var lblW = document.createElement("span");
            lblW.className = "field__label";
            lblW.textContent = "Полуширина перемычки, м";
            var inpW = document.createElement("input");
            inpW.type = "number";
            inpW.min = "0.5";
            inpW.max = "30";
            inpW.step = "0.5";
            inpW.value = "2";
            inpW.className = "modal__input";
            lab2.appendChild(lblW);
            lab2.appendChild(inpW);
            wrap.appendChild(p);
            wrap.appendChild(lab);
            wrap.appendChild(lab2);
            openModal("Связать полигоны в один объект", wrap, function () {
                var feat = buildLinkMergedPolygonFeature(poly, chk.checked, parseFloat(inpW.value, 10));
                closeModal();
                if (!feat) {
                    toast("Не удалось собрать MultiPolygon.");
                    return;
                }
                var undoPayload = poly.map(function (e) {
                    return {
                        feature: JSON.parse(JSON.stringify(e.feature)),
                        logicalLayerId: e.logicalLayerId
                    };
                });
                pickTargetLayerId("Слой для нового объекта", "Заменить выбранные", function (layerId) {
                    poly.forEach(function (e) {
                        destroyEntry(e);
                    });
                    clearSelection();
                    var newEntry = createFeatureEntry(feat, layerId);
                    setSelected(newEntry, true);
                    selectedOrder.push(newEntry);
                    updateSelectionBadge();
                    toast(
                        "Создан один MultiPolygon вместо " +
                            undoPayload.length +
                            " объект(ов). В KML — один placemark.",
                        "Отменить",
                        function () {
                            destroyEntry(newEntry);
                            undoPayload.forEach(function (u) {
                                createFeatureEntry(u.feature, u.logicalLayerId);
                            });
                            clearSelection();
                            updateSelectionBadge();
                        }
                    );
                });
            }, "Продолжить");
        });

        document.getElementById("union-btn").addEventListener("click", function () {
            var poly = selectedOrder.filter(isPolygonalEntry);
            if (poly.length < 2) {
                toast("Выберите минимум два полигона (Polygon / MultiPolygon).");
                return;
            }
            try {
                var g = leafToJstsGeom(poly[0]);
                for (var i = 1; i < poly.length; i++) {
                    g = g.union(leafToJstsGeom(poly[i]));
                }
                if (g.isEmpty()) {
                    toast("Объединение дало пустой результат.");
                    return;
                }
                var feat = jstsGeomToFeature(g);
                pickTargetLayerId("Объединение", "Добавить", function (layerId) {
                    addResultFeature(feat, layerId);
                    clearSelection();
                });
            } catch (err) {
                toast("Не удалось объединить. Проверьте геометрию.");
            }
        });

        document.getElementById("intersect-btn").addEventListener("click", function () {
            if (selectedOrder.length !== 2) {
                toast("Выберите ровно два полигона.");
                return;
            }
            if (!isPolygonalEntry(selectedOrder[0]) || !isPolygonalEntry(selectedOrder[1])) {
                toast("Нужны два полигона.");
                return;
            }
            try {
                var a = leafToJstsGeom(selectedOrder[0]);
                var b = leafToJstsGeom(selectedOrder[1]);
                var g = a.intersection(b);
                if (!g || g.isEmpty()) {
                    toast("Пересечение пустое.");
                    return;
                }
                var feat = jstsGeomToFeature(g);
                pickTargetLayerId("Пересечение", "Добавить", function (layerId) {
                    addResultFeature(feat, layerId);
                    clearSelection();
                });
            } catch (err) {
                toast("Ошибка пересечения.");
            }
        });

        document.getElementById("difference-btn").addEventListener("click", function () {
            if (selectedOrder.length !== 2) {
                toast("Выберите ровно два полигона (порядок: из первого вычитается второй).");
                return;
            }
            var A = selectedOrder[0];
            var B = selectedOrder[1];
            if (!isPolygonalEntry(A) || !isPolygonalEntry(B)) {
                toast("Нужны два полигона.");
                return;
            }
            try {
                var ga = leafToJstsGeom(A);
                var gb = leafToJstsGeom(B);
                var g = ga.difference(gb);
                if (!g || g.isEmpty()) {
                    toast("Результат вычитания пуст.");
                    return;
                }
                if (!g.isValid || !g.isValid()) {
                    toast("Результат некорректен для экспорта.");
                    return;
                }
                var feat = jstsGeomToFeature(g);
                pickTargetLayerId("Вычитание", "Заменить первый объект", function (layerId) {
                    setSelected(A, false);
                    setSelected(B, false);
                    selectedOrder = [];
                    destroyEntry(A);
                    addResultFeature(feat, layerId);
                    updateSelectionBadge();
                });
            } catch (err) {
                toast("Ошибка вычитания.");
            }
        });

        document.getElementById("symdiff-btn").addEventListener("click", function () {
            if (selectedOrder.length !== 2) {
                toast("Выберите ровно два полигона.");
                return;
            }
            if (!isPolygonalEntry(selectedOrder[0]) || !isPolygonalEntry(selectedOrder[1])) {
                toast("Нужны два полигона.");
                return;
            }
            try {
                var a = leafToJstsGeom(selectedOrder[0]);
                var b = leafToJstsGeom(selectedOrder[1]);
                var g = jstsSymmetricDifference(a, b);
                if (!g || g.isEmpty()) {
                    toast("Симметричная разность пуста.");
                    return;
                }
                var feat = jstsGeomToFeature(g);
                pickTargetLayerId("Симметричная разность", "Добавить", function (layerId) {
                    addResultFeature(feat, layerId);
                    clearSelection();
                });
            } catch (err) {
                toast("Ошибка симметричной разности.");
            }
        });

        function explodeGeometry(geom) {
            var out = [];
            if (!geom) return out;
            if (geom.type === "MultiPolygon") {
                geom.coordinates.forEach(function (ringSet) {
                    out.push({ type: "Polygon", coordinates: ringSet });
                });
                return out;
            }
            if (geom.type === "MultiLineString") {
                geom.coordinates.forEach(function (line) {
                    out.push({ type: "LineString", coordinates: line });
                });
                return out;
            }
            if (geom.type === "MultiPoint") {
                geom.coordinates.forEach(function (pt) {
                    out.push({ type: "Point", coordinates: pt });
                });
                return out;
            }
            if (geom.type === "GeometryCollection" && geom.geometries) {
                geom.geometries.forEach(function (g) {
                    out = out.concat(explodeGeometry(g));
                });
                return out;
            }
            return [geom];
        }

        document.getElementById("explode-btn").addEventListener("click", function () {
            if (selectedOrder.length !== 1) {
                toast("Выберите один объект с Multi-геометрией.");
                return;
            }
            var entry = selectedOrder[0];
            var gj = entryToGeoJSON(entry);
            if (!gj || !gj.geometry) return;
            var parts = explodeGeometry(gj.geometry);
            if (parts.length <= 1) {
                toast("Нечего разбивать (одна часть).");
                return;
            }
            var layerId = entry.logicalLayerId;
            setSelected(entry, false);
            selectedOrder = [];
            destroyEntry(entry);
            parts.forEach(function (g) {
                addResultFeature({ type: "Feature", properties: gj.properties || {}, geometry: g }, layerId);
            });
            updateSelectionBadge();
            toast("Разбито на " + parts.length + " объект(ов).");
        });

        document.getElementById("delete-object-btn").addEventListener("click", function () {
            if (!selectedOrder.length) {
                toast("Выберите объекты для удаления.");
                return;
            }
            var toDel = selectedOrder.slice();
            clearSelection();
            deletedObjects = [];
            toDel.forEach(function (entry) {
                var snap = JSON.parse(JSON.stringify(entry.feature));
                var lid = entry.logicalLayerId;
                destroyEntry(entry);
                deletedObjects.push({ feature: snap, logicalId: lid });
            });
            toast("Удалено объектов: " + toDel.length, "Отменить", function () {
                deletedObjects.forEach(function (item) {
                    createFeatureEntry(item.feature, item.logicalId);
                });
                deletedObjects = [];
            });
        });

        document.querySelectorAll("[data-draw-mode]").forEach(function (btn) {
            btn.addEventListener("click", function () {
                var m = btn.getAttribute("data-draw-mode");
                if (m === "select") {
                    exitDraw(true);
                    return;
                }
                if (m === "move") {
                    exitDraw(true);
                    drawState.mode = "move";
                    setDrawUI();
                    toast(
                        "Режим «Перемещение»: один выбранный объект — тяните за заливку или линию. «Выбор» — обычная работа с картой."
                    );
                    queueVertexEditorSync();
                    return;
                }
                startDrawMode(m);
            });
        });
        var dc = document.getElementById("draw-complete");
        if (dc) dc.addEventListener("click", finishDrawPolygonOrLine);
        var dcan = document.getElementById("draw-cancel");
        if (dcan)
            dcan.addEventListener("click", function () {
                exitDraw(true);
            });
        bindLayerListDragAndDrop();
        setDrawUI();
        initCompareModeBindings();
    }

    async function main() {
        var API_KEY = window.YANDEX_MAPS_API_KEY;
        if (!API_KEY || String(API_KEY).indexOf("ВАШ_") === 0 || String(API_KEY).indexOf("YOUR_") === 0) {
            var mapEl = document.getElementById("map");
            if (mapEl) {
                mapEl.innerHTML =
                    '<div class="map-error"><p>Укажите ключ API в файле <code>config.js</code> (см. <code>config.example.js</code>).</p><p class="map-error__sub">Нужен ключ «JavaScript API и Геокодер» с ограничением по HTTP Referer.</p></div>';
            }
            initCompareModeBindings();
            return;
        }

        if (typeof ymaps3 === "undefined") {
            throw new Error("ymaps3 не загружен");
        }

        await ymaps3.ready;

        var YMap = ymaps3.YMap;
        YMapFeature = ymaps3.YMapFeature;
        var YMapDefaultSchemeLayer = ymaps3.YMapDefaultSchemeLayer;
        var YMapDefaultFeaturesLayer = ymaps3.YMapDefaultFeaturesLayer;
        var YMapCollection = ymaps3.YMapCollection;
        YMapListener = ymaps3.YMapListener;

        map = new YMap(
            document.getElementById("map"),
            {
                location: {
                    center: [37.618423, 55.751244],
                    zoom: 5
                }
            },
            [new YMapDefaultSchemeLayer({}), new YMapDefaultFeaturesLayer({})]
        );

        if (typeof YMapCollection === "function") {
            vertexEditLayer = new YMapCollection({});
            map.addChild(vertexEditLayer);
        }

        var mapContainerEl = document.getElementById("map");
        if (mapContainerEl) {
            mapContainerEl.addEventListener(
                "pointerdown",
                function (ev) {
                    captureMapPointerModifiersFromDom(ev);
                },
                true
            );
            mapContainerEl.addEventListener(
                "mousedown",
                function (ev) {
                    captureMapPointerModifiersFromDom(ev);
                },
                true
            );
        }
        /* Слой карты может быть в shadow DOM — событие не доходит до #map, зато window capture видит shiftKey. */
        function captureModifiersFromWindow(ev) {
            captureMapPointerModifiersFromDom(ev);
        }
        window.addEventListener("pointerdown", captureModifiersFromWindow, true);
        window.addEventListener("mousedown", captureModifiersFromWindow, true);
        window.addEventListener("touchstart", captureModifiersFromWindow, true);

        map.addChild(
            new YMapListener({
                onUpdate: function (payload) {
                    try {
                        if (payload && payload.location && typeof payload.location.zoom === "number") {
                            lastMapZoomForVertex = payload.location.zoom;
                        }
                    } catch (e) {
                        /* ignore */
                    }
                }
            })
        );

        map.addChild(
            new YMapListener({
                layer: "any",
                onFastClick: onFastClickDom,
                onClick: onDelayedClickDom,
                onMouseDown: function (object, event) {
                    captureMapPointerModifiersFromDom(extractNativeDomEventFromListener(event));
                    tryStartVertexDrag(object, event);
                    if (!vertexDragState) tryStartFeatureBodyDrag(object, event);
                },
                onTouchStart: function (object, event) {
                    captureMapPointerModifiersFromDom(extractNativeDomEventFromListener(event));
                    tryStartVertexDrag(object, event);
                    if (!vertexDragState) tryStartFeatureBodyDrag(object, event);
                },
                onMouseMove: function (object, event) {
                    var el = document.getElementById("coords-hint");
                    var c = lngLatFromDomEvent(event);
                    if (vertexDragState && c) {
                        applyVertexDragAtLngLat(c);
                    } else if (featureBodyDragState) {
                        applyFeatureBodyDragFromMapListenerEvent(event);
                    }
                    if (el && c) {
                        el.textContent = c[1].toFixed(5) + ", " + c[0].toFixed(5) + " · Яндекс";
                    }
                    if (drawState.mode === "rect" && drawState.rectCorner && c) {
                        drawState.rectHover = c;
                        syncRectPreviewPoly(drawState.rectCorner, c);
                    }
                },
                onTouchMove: function (object, event) {
                    var c = lngLatFromDomEvent(event);
                    if (vertexDragState && c) {
                        applyVertexDragAtLngLat(c);
                    } else if (featureBodyDragState) {
                        applyFeatureBodyDragFromMapListenerEvent(event);
                    }
                }
            })
        );

        window.addEventListener("mouseup", onWindowVertexDragEnd);
        window.addEventListener("touchend", onWindowVertexDragEnd);
        window.addEventListener("touchcancel", onWindowVertexDragEnd);

        bindUi();

        addLogicalLayer("Слой 1");
        updateImportSelect();
    }

    main().catch(function (err) {
        console.error(err);
        var mapEl = document.getElementById("map");
        if (mapEl) {
            mapEl.innerHTML =
                '<div class="map-error"><p>Не удалось открыть карту.</p><p class="map-error__sub">' +
                String(err && err.message ? err.message : err) +
                "</p></div>";
        }
    });
})();
