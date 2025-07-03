// ====== Карта и базовые переменные ======
var map = L.map('map').setView([55.751244, 37.618423], 5);

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap contributors'
}).addTo(map);

var layers = {}; // {name: L.FeatureGroup}
var layerOrder = [];
var layerCount = 0;
var selectedLayersOrder = [];
var deletedObjects = [];
var reader = new jsts.io.GeoJSONReader();
var writer = new jsts.io.GeoJSONWriter();

// ====== Универсальная функция модального окна ======
function showModal({ title, content, onConfirm, onCancel, confirmText = "OK", cancelText = "Отмена", focusInput = false }) {
  const root = document.getElementById('modal-root');
  root.innerHTML = '';
  root.classList.add('show');

  const modal = document.createElement('div');
  modal.className = 'modal';
  if (title) {
    const h = document.createElement('h3');
    h.textContent = title;
    modal.appendChild(h);
  }
  if (typeof content === 'string') {
    const p = document.createElement('div');
    p.innerHTML = content;
    modal.appendChild(p);
  } else if (content instanceof HTMLElement) {
    modal.appendChild(content);
  }
  // Actions
  const actions = document.createElement('div');
  actions.className = 'modal-actions';

  const cancelBtn = document.createElement('button');
  cancelBtn.textContent = cancelText;
  cancelBtn.className = 'modal-cancel';
  cancelBtn.onclick = () => {
    root.classList.remove('show');
    root.innerHTML = '';
    if (onCancel) onCancel();
  };
  actions.appendChild(cancelBtn);

  const okBtn = document.createElement('button');
  okBtn.textContent = confirmText;
  okBtn.onclick = () => {
    root.classList.remove('show');
    root.innerHTML = '';
    if (onConfirm) onConfirm();
  };
  actions.appendChild(okBtn);

  modal.appendChild(actions);

  // Крестик для закрытия
  const closeBtn = document.createElement('button');
  closeBtn.innerHTML = '&times;';
  closeBtn.className = 'modal-close';
  closeBtn.onclick = cancelBtn.onclick;
  modal.appendChild(closeBtn);

  root.appendChild(modal);

  // Автофокус на input, если нужно
  if (focusInput) {
    setTimeout(() => {
      const inp = modal.querySelector('input,select');
      if (inp) inp.focus();
    }, 100);
  }
}

// ====== Выбор слоя из списка (callback возвращает имя слоя) ======
function selectLayerDialog(callback, title = "Выберите слой") {
  const select = document.createElement('select');
  Object.keys(layers).forEach(name => {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    select.appendChild(opt);
  });
  showModal({
    title,
    content: select,
    confirmText: 'Выбрать',
    onConfirm: () => callback(select.value),
    focusInput: true
  });
}

// ====== Диалог переименования слоя ======
function renameLayerDialog(oldName, callback) {
  const input = document.createElement('input');
  input.type = 'text';
  input.value = oldName;
  input.placeholder = 'Новое имя слоя';
  showModal({
    title: 'Переименовать слой',
    content: input,
    confirmText: 'Переименовать',
    focusInput: true,
    onConfirm: () => {
      const newName = input.value.trim();
      if (!newName || layers[newName]) {
        showModal({
          title: "Ошибка",
          content: "Некорректное или занятое имя слоя.",
          confirmText: "ОК"
        });
      } else {
        callback(newName);
      }
    }
  });
}

// ====== Подтверждение удаления слоя ======
function confirmDeleteLayer(layerName, callback) {
  showModal({
    title: 'Удалить слой?',
    content: `Вы уверены, что хотите удалить слой <b>${layerName}</b>?`,
    confirmText: 'Удалить',
    onConfirm: callback
  });
}

// ====== Sidebar: список слоёв ======
function updateLayerList() {
  var layerList = document.getElementById('layer-list');
  layerList.innerHTML = '';

  layerOrder.forEach(function(layerName) {
    var layerItem = document.createElement('li');
    layerItem.className = 'layer-item';

    // DRAG HANDLE
    var dragHandle = document.createElement('span');
    dragHandle.className = 'drag-handle';
    dragHandle.title = 'Перетащить слой';
    dragHandle.setAttribute('data-tooltip', 'Перетащить слой');
    dragHandle.innerHTML = `<svg width="18" height="18" fill="none" stroke="#b3bddc" stroke-width="2" stroke-linecap="round">
      <circle cx="6" cy="6" r="1.2"/><circle cx="12" cy="6" r="1.2"/>
      <circle cx="6" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/>
    </svg>`;

    // Контролы слоя
    var controlsDiv = document.createElement('div');
    controlsDiv.className = 'layer-controls';

    // Видимость
    var visibilityCheckbox = document.createElement('input');
    visibilityCheckbox.type = 'checkbox';
    visibilityCheckbox.checked = map.hasLayer(layers[layerName]);
    visibilityCheckbox.title = 'Показать/скрыть слой';
    visibilityCheckbox.setAttribute('data-tooltip', 'Показать/скрыть слой');
    visibilityCheckbox.dataset.layerName = layerName;
    visibilityCheckbox.addEventListener('change', function(e) {
      var name = e.target.dataset.layerName;
      if (e.target.checked) {
        map.addLayer(layers[name]);
      } else {
        map.removeLayer(layers[name]);
      }
    });

    // Имя слоя (редактируемое, по двойному клику)
    var nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.value = layerName;
    nameInput.dataset.oldName = layerName;
    nameInput.title = 'Двойной клик для переименования';
    nameInput.setAttribute('data-tooltip', 'Двойной клик для переименования');
    nameInput.readOnly = true;
    nameInput.addEventListener('dblclick', function(e) {
      const oldName = e.target.dataset.oldName;
      renameLayerDialog(oldName, function(newName) {
        layers[newName] = layers[oldName];
        delete layers[oldName];
        const idx = layerOrder.indexOf(oldName);
        if (idx !== -1) layerOrder[idx] = newName;
        updateLayerList();
      });
    });

    // Кнопка удаления
    var deleteButton = document.createElement('button');
    deleteButton.innerHTML = `<svg width="16" height="16" fill="none" stroke="#e05d5d" stroke-width="2"><polyline points="3 6 5 6 13 6"/><path d="M11 6l-1.5 7.5a1 1 0 0 1-1 1H7.5a1 1 0 0 1-1-1L5 6"/><path d="M7.5 9v3"/><path d="M9.5 9v3"/><path d="M5 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>`;
    deleteButton.dataset.layerName = layerName;
    deleteButton.setAttribute('data-tooltip', 'Удалить слой');
    deleteButton.addEventListener('click', function(e) {
      confirmDeleteLayer(layerName, function() {
        map.removeLayer(layers[layerName]);
        delete layers[layerName];
        var idx = layerOrder.indexOf(layerName);
        if (idx !== -1) layerOrder.splice(idx, 1);
        updateLayerList();
      });
    });

    controlsDiv.appendChild(visibilityCheckbox);
    controlsDiv.appendChild(nameInput);
    controlsDiv.appendChild(deleteButton);

    layerItem.appendChild(dragHandle);
    layerItem.appendChild(controlsDiv);
    layerList.appendChild(layerItem);
  });
}

// ====== Добавление нового слоя ======
function addNewLayer(name) {
  if (!name) {
    layerCount++;
    name = 'Слой ' + layerCount;
  }
  if (layers[name]) return null;
  var layerGroup = new L.FeatureGroup();
  layers[name] = layerGroup;
  layerOrder.push(name);
  map.addLayer(layerGroup);
  updateLayerList();
  updateMapLayersOrder();
  return layerGroup;
}

// ====== Порядок слоёв на карте ======
function updateMapLayersOrder() {
  layerOrder.forEach(function(layerName) {
    var layer = layers[layerName];
    map.removeLayer(layer);
  });
  layerOrder.forEach(function(layerName) {
    var layer = layers[layerName];
    map.addLayer(layer);
  });
}

// ====== KML Импорт ======
document.getElementById('file-input').addEventListener('change', function(e) {
  var file = e.target.files[0];
  if (!file) return;
  var readerFile = new FileReader();
  readerFile.onload = function() {
    var text = readerFile.result;
    var parser = new DOMParser();
    var kml = parser.parseFromString(text, 'text/xml');
    var geojson = toGeoJSON.kml(kml);
    var layerNames = Object.keys(layers);
    if (layerNames.length === 0) {
      showModal({ title: "Ошибка", content: "Сначала создайте слой для импорта KML-файла.", confirmText: "ОК" });
      return;
    }
    selectLayerDialog(function(layerName) {
      var targetLayer = layers[layerName];
      var layerGroup = L.geoJSON(geojson, {
        onEachFeature: function(feature, layer) {
          addClickHandler(layer);
          layer.parentLayerGroup = targetLayer;
        }
      });
      layerGroup.eachLayer(function(layer) {
        targetLayer.addLayer(layer);
      });
      map.fitBounds(layerGroup.getBounds());
    }, "Выберите слой для импорта");
  };
  readerFile.readAsText(file);
});

// ====== Новый слой ======
document.getElementById('add-layer-btn').addEventListener('click', function() {
  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = 'Название слоя';
  showModal({
    title: 'Создать новый слой',
    content: input,
    confirmText: 'Создать',
    focusInput: true,
    onConfirm: () => {
      const val = input.value.trim();
      if (!val) return;
      if (layers[val]) {
        showModal({
          title: "Ошибка",
          content: "Слой с таким именем уже существует.",
          confirmText: "ОК"
        });
      } else {
        addNewLayer(val);
      }
    }
  });
});

// ====== Сохранить все слои в KML ======
document.getElementById('save-btn').addEventListener('click', function() {
  var allFeatures = [];
  Object.values(layers).forEach(function(layerGroup) {
    var geojson = layerGroup.toGeoJSON();
    allFeatures = allFeatures.concat(geojson.features);
  });
  var combinedGeoJSON = {
    type: 'FeatureCollection',
    features: allFeatures
  };
  var kml = tokml(combinedGeoJSON);
  var blob = new Blob([kml], { type: 'application/vnd.google-earth.kml+xml' });
  var url = URL.createObjectURL(blob);
  var link = document.createElement('a');
  link.href = url;
  link.download = 'merged_layers.kml';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
});

// ====== Leaflet Draw ======
var drawnItems = new L.FeatureGroup();
map.addLayer(drawnItems);

var drawControl = new L.Control.Draw({
  edit: {
    featureGroup: drawnItems
  },
  draw: {
    polygon: true,
    polyline: true,
    rectangle: true,
    circle: true,
    marker: true
  }
});
map.addControl(drawControl);

map.on('draw:created', function(e) {
  var layer = e.layer;
  var layerNames = Object.keys(layers);
  if (layerNames.length === 0) {
    showModal({ title: "Ошибка", content: "Сначала создайте слой для добавления объекта.", confirmText: "ОК" });
    return;
  }
  selectLayerDialog(function(layerName) {
    var targetLayer = layers[layerName];
    addClickHandler(layer);
    layer.parentLayerGroup = targetLayer;
    targetLayer.addLayer(layer);
  }, "Выберите слой для добавления объекта");
});

// ====== Выделение объектов по клику ======
function onFeatureClick(e) {
  var layer = e.target;
  if (layer.selected) {
    layer.setStyle({ color: '#3388ff' });
    layer.selected = false;
    selectedLayersOrder = selectedLayersOrder.filter(function(l) {
      return l !== layer;
    });
  } else {
    layer.setStyle({ color: 'red' });
    layer.selected = true;
    selectedLayersOrder.push(layer);
  }
}
function addClickHandler(layer) {
  layer.on('click', onFeatureClick);
}

// ====== Служебная: инвертирование координат ======
function invertCoordinates(geojson) {
  if (!geojson || !geojson.geometry) return;
  function invertCoords(coords) {
    if (typeof coords[0] === 'number') {
      return [coords[1], coords[0]];
    } else {
      return coords.map(invertCoords);
    }
  }
  var geom = geojson.geometry;
  if (geom.type === 'GeometryCollection') {
    geom.geometries.forEach(function(g) {
      g.coordinates = invertCoords(g.coordinates);
    });
  } else {
    geom.coordinates = invertCoords(geom.coordinates);
  }
}

// ====== UNION ======
document.getElementById('union-btn').addEventListener('click', function() {
  if (selectedLayersOrder.length < 2) {
    showModal({ title: "Ошибка", content: "Выберите как минимум два объекта для объединения.", confirmText: "ОК" });
    return;
  }
  var geometries = selectedLayersOrder.map(function(layer) {
    var geojson = layer.toGeoJSON();
    invertCoordinates(geojson);
    return reader.read(geojson.geometry);
  });
  var unionGeometry = geometries[0];
  for (var i = 1; i < geometries.length; i++) {
    unionGeometry = unionGeometry.union(geometries[i]);
  }
  if (unionGeometry.isEmpty()) {
    showModal({ title: "Ошибка", content: "Не удалось объединить объекты.", confirmText: "ОК" });
    return;
  }
  var unionedFeature = {
    type: 'Feature',
    properties: {},
    geometry: writer.write(unionGeometry)
  };
  invertCoordinates(unionedFeature);
  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = 'Название слоя';
  showModal({
    title: 'Создать слой для результата объединения',
    content: input,
    confirmText: 'Создать',
    focusInput: true,
    onConfirm: () => {
      const newLayerName = input.value.trim();
      if (!newLayerName) return;
      var targetLayer = layers[newLayerName] || addNewLayer(newLayerName);
      var newLayer = L.geoJSON(unionedFeature, {
        onEachFeature: function(feature, layer) {
          addClickHandler(layer);
          layer.parentLayerGroup = targetLayer;
        }
      });
      newLayer.eachLayer(function(layer) {
        targetLayer.addLayer(layer);
      });
      selectedLayersOrder.forEach(function(layer) {
        layer.setStyle({ color: '#3388ff' });
        layer.selected = false;
      });
      selectedLayersOrder = [];
    }
  });
});

// ====== DIFFERENCE ======
document.getElementById('difference-btn').addEventListener('click', function() {
  if (selectedLayersOrder.length !== 2) {
    showModal({ title: "Ошибка", content: "Выберите ровно два объекта для вычитания.", confirmText: "ОК" });
    return;
  }
  var layerA = selectedLayersOrder[0];
  var layerB = selectedLayersOrder[1];
  var geojsonA = layerA.toGeoJSON();
  var geojsonB = layerB.toGeoJSON();
  invertCoordinates(geojsonA);
  invertCoordinates(geojsonB);

  var geometryA, geometryB;
  try {
    geometryA = reader.read(geojsonA.geometry);
    geometryB = reader.read(geojsonB.geometry);
  } catch (error) {
    showModal({ title: "Ошибка", content: "Ошибка чтения геометрий.", confirmText: "ОК" });
    return;
  }
  var differenceGeometry;
  try {
    differenceGeometry = geometryA.difference(geometryB);
  } catch (error) {
    showModal({ title: "Ошибка", content: "Ошибка при вычитании объектов.", confirmText: "ОК" });
    return;
  }
  if (differenceGeometry.isEmpty() || !differenceGeometry.isValid()) {
    showModal({ title: "Ошибка", content: "Результат пуст или некорректен.", confirmText: "ОК" });
    return;
  }
  var differenceFeature = {
    type: 'Feature',
    properties: {},
    geometry: writer.write(differenceGeometry)
  };
  invertCoordinates(differenceFeature);
  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = 'Название слоя';
  showModal({
    title: 'Создать слой для результата вычитания',
    content: input,
    confirmText: 'Создать',
    focusInput: true,
    onConfirm: () => {
      const newLayerName = input.value.trim();
      if (!newLayerName) return;
      var targetLayer = layers[newLayerName] || addNewLayer(newLayerName);
      if (layerA.parentLayerGroup) layerA.parentLayerGroup.removeLayer(layerA);
      var newLayer = L.geoJSON(differenceFeature, {
        onEachFeature: function(feature, layer) {
          addClickHandler(layer);
          layer.parentLayerGroup = targetLayer;
        }
      });
      newLayer.eachLayer(function(layer) {
        targetLayer.addLayer(layer);
      });
      layerB.setStyle({ color: '#3388ff' });
      layerB.selected = false;
      selectedLayersOrder = [];
    }
  });
});

// ====== Удаление выбранных объектов ======
document.getElementById('delete-object-btn').addEventListener('click', function() {
  if (selectedLayersOrder.length === 0) {
    showModal({ title: "Ошибка", content: "Выберите объект(ы) для удаления.", confirmText: "ОК" });
    return;
  }
  var layersToDelete = selectedLayersOrder.slice();
  selectedLayersOrder = [];
  layersToDelete.forEach(function(layer) {
    if (layer.parentLayerGroup) {
      layer.parentLayerGroup.removeLayer(layer);
    } else {
      map.removeLayer(layer);
    }
    deletedObjects.push({
      layer: layer,
      parentLayerGroup: layer.parentLayerGroup,
      time: Date.now()
    });
  });
  showUndoNotification();
});

function showUndoNotification() {
  var undoContainer = document.createElement('div');
  undoContainer.id = 'undo-container';
  undoContainer.style.position = 'absolute';
  undoContainer.style.bottom = '20px';
  undoContainer.style.left = '20px';
  undoContainer.style.padding = '10px 20px';
  undoContainer.style.backgroundColor = 'rgba(36, 86, 166, 0.9)';
  undoContainer.style.color = '#fff';
  undoContainer.style.borderRadius = '9px';
  undoContainer.style.zIndex = '1000';
  undoContainer.style.fontSize = '1em';
  undoContainer.innerHTML = 'Объекты удалены. <button id="undo-button" style="background:#fff;color:#2456a6;border:none;border-radius:5px;padding:4px 10px;cursor:pointer;font-weight:500;">Отменить</button>';
  document.body.appendChild(undoContainer);
  var undoButton = document.getElementById('undo-button');
  undoButton.addEventListener('click', function() {
    deletedObjects.forEach(function(item) {
      if (item.parentLayerGroup) item.parentLayerGroup.addLayer(item.layer);
      else map.addLayer(item.layer);
    });
    deletedObjects = [];
    document.body.removeChild(undoContainer);
    clearTimeout(undoTimeout);
  });
  var undoTimeout = setTimeout(function() {
    deletedObjects = [];
    if (document.body.contains(undoContainer)) document.body.removeChild(undoContainer);
  }, 15000);
}

// ====== Drag&Drop: обновление порядка (SortableJS интеграция через index.html) ======

// ====== Инициализация: пустой слой для теста ======
if (layerOrder.length === 0) addNewLayer();

