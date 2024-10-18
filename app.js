// Инициализация карты
var map = L.map('map').setView([55.751244, 37.618423], 5);

// Добавление базового слоя карты
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap contributors'
}).addTo(map);

// Объект для хранения слоёв
var layers = {};
var layerOrder = [];
var layerCount = 0;

// Создание парсеров для GeoJSON и JSTS
var reader = new jsts.io.GeoJSONReader();
var writer = new jsts.io.GeoJSONWriter();

// Массив для хранения порядка выбранных объектов
var selectedLayersOrder = [];

// Массив для хранения удалённых объектов для отмены удаления
var deletedObjects = [];

// Функция для добавления нового слоя
function addNewLayer(name) {
    if (!name) {
        layerCount++;
        name = 'Слой ' + layerCount;
    }

    // Создаём новый FeatureGroup для слоя
    var layerGroup = new L.FeatureGroup();
    layers[name] = layerGroup;
    layerOrder.push(name);
    map.addLayer(layerGroup);

    updateLayerList();
    updateMapLayersOrder();

    return layerGroup;
}

// Функция для обновления порядка слоёв на карте
function updateMapLayersOrder() {
    // Удаляем все слои с карты
    layerOrder.forEach(function(layerName) {
        var layer = layers[layerName];
        map.removeLayer(layer);
    });
    // Добавляем слои на карту в новом порядке
    layerOrder.forEach(function(layerName) {
        var layer = layers[layerName];
        map.addLayer(layer);
    });
}

// Обновление списка слоёв в боковом меню
function updateLayerList() {
    var layerList = document.getElementById('layer-list');
    layerList.innerHTML = '';

    layerOrder.forEach(function(layerName, index) {
        var layerItem = document.createElement('li');
        layerItem.className = 'layer-item';

        // Чекбокс видимости слоя
        var visibilityCheckbox = document.createElement('input');
        visibilityCheckbox.type = 'checkbox';
        visibilityCheckbox.checked = map.hasLayer(layers[layerName]);
        visibilityCheckbox.dataset.layerName = layerName;
        visibilityCheckbox.addEventListener('change', function(e) {
            var layerName = e.target.dataset.layerName;
            if (e.target.checked) {
                map.addLayer(layers[layerName]);
            } else {
                map.removeLayer(layers[layerName]);
            }
        });

        // Поле для редактирования имени слоя
        var nameInput = document.createElement('input');
        nameInput.type = 'text';
        nameInput.value = layerName;
        nameInput.dataset.oldName = layerName;
        nameInput.addEventListener('change', function(e) {
            var oldName = e.target.dataset.oldName;
            var newName = e.target.value;

            // Проверка на уникальность имени
            if (layers[newName] && newName !== oldName) {
                alert('Слой с таким именем уже существует!');
                e.target.value = oldName;
                return;
            }

            // Переименование слоя
            layers[newName] = layers[oldName];
            delete layers[oldName];
            e.target.dataset.oldName = newName;

            // Обновляем layerOrder
            var idx = layerOrder.indexOf(oldName);
            if (idx !== -1) {
                layerOrder[idx] = newName;
            }

            updateLayerList();
        });

        // Кнопка удаления слоя
        var deleteButton = document.createElement('button');
        deleteButton.textContent = 'Удалить';
        deleteButton.dataset.layerName = layerName;
        deleteButton.addEventListener('click', function(e) {
            var layerName = e.target.dataset.layerName;
            map.removeLayer(layers[layerName]);
            delete layers[layerName];
            var idx = layerOrder.indexOf(layerName);
            if (idx !== -1) {
                layerOrder.splice(idx, 1);
            }
            updateLayerList();
        });

        // Кнопки перемещения слоя вверх и вниз
        var upButton = document.createElement('button');
        upButton.textContent = '▲';
        upButton.dataset.layerIndex = index;
        upButton.addEventListener('click', function(e) {
            var idx = parseInt(e.target.dataset.layerIndex);
            if (idx > 0) {
                // Меняем слои местами в layerOrder
                var temp = layerOrder[idx - 1];
                layerOrder[idx - 1] = layerOrder[idx];
                layerOrder[idx] = temp;
                // Обновляем порядок слоёв на карте
                updateMapLayersOrder();
                updateLayerList();
            }
        });

        var downButton = document.createElement('button');
        downButton.textContent = '▼';
        downButton.dataset.layerIndex = index;
        downButton.addEventListener('click', function(e) {
            var idx = parseInt(e.target.dataset.layerIndex);
            if (idx < layerOrder.length - 1) {
                // Меняем слои местами в layerOrder
                var temp = layerOrder[idx + 1];
                layerOrder[idx + 1] = layerOrder[idx];
                layerOrder[idx] = temp;
                // Обновляем порядок слоёв на карте
                updateMapLayersOrder();
                updateLayerList();
            }
        });

        // Собираем элементы вместе
        var controlsDiv = document.createElement('div');
        controlsDiv.className = 'layer-controls';
        controlsDiv.appendChild(visibilityCheckbox);
        controlsDiv.appendChild(nameInput);
        controlsDiv.appendChild(upButton);
        controlsDiv.appendChild(downButton);
        controlsDiv.appendChild(deleteButton);

        layerItem.appendChild(controlsDiv);
        layerList.appendChild(layerItem);
    });
}

// Добавление обработчика для кнопки "Добавить новый слой"
document.getElementById('add-layer-btn').addEventListener('click', function() {
    var layerName = prompt('Введите название нового слоя:');
    if (layerName) {
        if (layers[layerName]) {
            alert('Слой с таким именем уже существует!');
        } else {
            addNewLayer(layerName);
        }
    }
});

// Обработчик загрузки KML-файла
document.getElementById('file-input').addEventListener('change', function(e) {
    var file = e.target.files[0];
    if (!file) return;

    var reader = new FileReader();
    reader.onload = function() {
        var text = reader.result;
        var parser = new DOMParser();
        var kml = parser.parseFromString(text, 'text/xml');
        var geojson = toGeoJSON.kml(kml);

        // Список доступных слоёв
        var layerNames = Object.keys(layers);
        if (layerNames.length === 0) {
            alert('Сначала создайте слой для импорта KML-файла.');
            return;
        }

        // Предлагаем выбрать слой для импорта
        var layerName = prompt('Введите название слоя для импорта KML-файла:\n' + layerNames.join('\n'));
        if (!layerName || !layers[layerName]) {
            alert('Слой не найден.');
            return;
        }

        var targetLayer = layers[layerName];

        var layerGroup = L.geoJSON(geojson, {
            onEachFeature: function(feature, layer) {
                addClickHandler(layer);
                layer.parentLayerGroup = targetLayer; // Сохраняем ссылку на родительский слой
            }
        });

        layerGroup.eachLayer(function(layer) {
            targetLayer.addLayer(layer);
        });

        map.fitBounds(layerGroup.getBounds());
    };
    reader.readAsText(file);
});

// Добавление инструментов рисования и редактирования
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

// Обработка событий рисования
map.on('draw:created', function(e) {
    var type = e.layerType;
    var layer = e.layer;

    // Список доступных слоёв
    var layerNames = Object.keys(layers);
    if (layerNames.length === 0) {
        alert('Сначала создайте слой для добавления объекта.');
        return;
    }

    // Предлагаем выбрать слой для добавления объекта
    var layerName = prompt('Введите название слоя для добавления объекта:\n' + layerNames.join('\n'));
    if (!layerName || !layers[layerName]) {
        alert('Слой не найден.');
        return;
    }

    var targetLayer = layers[layerName];

    addClickHandler(layer);
    layer.parentLayerGroup = targetLayer; // Сохраняем ссылку на родительский слой

    targetLayer.addLayer(layer);
});

// Обработка событий редактирования
map.on('draw:edited', function(e) {
    // Можно добавить дополнительную логику здесь
});

// Функция для инвертирования координат
function invertCoordinates(geojson) {
    if (!geojson || !geojson.geometry) return;

    function invertCoords(coords) {
        if (typeof coords[0] === 'number') {
            // Это координаты точки
            return [coords[1], coords[0]];
        } else {
            // Это массив координат
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

// Обработчик клика на объекте, учитывающий порядок выбора
function onFeatureClick(e) {
    var layer = e.target;
    if (layer.selected) {
        layer.setStyle({ color: '#3388ff' });
        layer.selected = false;
        // Удаляем слой из массива выбранных в порядке выбора
        selectedLayersOrder = selectedLayersOrder.filter(function(l) {
            return l !== layer;
        });
    } else {
        layer.setStyle({ color: 'red' });
        layer.selected = true;
        // Добавляем слой в массив выбранных в порядке выбора
        selectedLayersOrder.push(layer);
    }
}

// Функция для добавления обработчика клика на слой
function addClickHandler(layer) {
    layer.on('click', onFeatureClick);
}

// Сохранение всех слоёв в KML-файл
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

// Объединение выбранных объектов с использованием JSTS
document.getElementById('union-btn').addEventListener('click', function() {
    if (selectedLayersOrder.length < 2) {
        alert('Выберите как минимум два объекта с геометрией типа Polygon или MultiPolygon для объединения.');
        return;
    }

    // Преобразование GeoJSON в геометрии JSTS
    var geometries = selectedLayersOrder.map(function(layer) {
        var geojson = layer.toGeoJSON();
        invertCoordinates(geojson);
        return reader.read(geojson.geometry);
    });

    // Объединение геометрий
    var unionGeometry = geometries[0];
    for (var i = 1; i < geometries.length; i++) {
        unionGeometry = unionGeometry.union(geometries[i]);
    }

    // Проверка, что результат не пустой
    if (unionGeometry.isEmpty()) {
        alert('Не удалось объединить выбранные объекты.');
        return;
    }

    // Преобразование результата обратно в GeoJSON
    var unionedFeature = {
        type: 'Feature',
        properties: {},
        geometry: writer.write(unionGeometry)
    };

    // Инвертируем координаты обратно
    invertCoordinates(unionedFeature);

    // Добавляем результат в новый слой
    var newLayerName = prompt('Введите название слоя для объединённого объекта:');
    if (newLayerName) {
        var targetLayer;
        if (layers[newLayerName]) {
            targetLayer = layers[newLayerName];
        } else {
            targetLayer = addNewLayer(newLayerName);
        }

        var newLayer = L.geoJSON(unionedFeature, {
            onEachFeature: function(feature, layer) {
                addClickHandler(layer);
                layer.parentLayerGroup = targetLayer; // Сохраняем ссылку на родительский слой
            }
        });

        newLayer.eachLayer(function(layer) {
            targetLayer.addLayer(layer);
        });
    } else {
        alert('Операция отменена.');
        return;
    }

    // Сбрасываем выбор
    selectedLayersOrder.forEach(function(layer) {
        layer.setStyle({ color: '#3388ff' });
        layer.selected = false;
    });
    selectedLayersOrder = [];
});

// Вырезание общих частей между объектами с использованием JSTS
document.getElementById('difference-btn').addEventListener('click', function() {
    console.log('Нажата кнопка вычитания объектов.');

    if (selectedLayersOrder.length !== 2) {
        alert('Выберите ровно два объекта с геометрией типа Polygon или MultiPolygon для вычитания.');
        return;
    }

    // Определяем порядок объектов
    var layerA = selectedLayersOrder[0];
    var layerB = selectedLayersOrder[1];

    console.log('Первый выбранный слой (из которого вычитаем):', layerA);
    console.log('Второй выбранный слой (который вычитаем):', layerB);

    var geojsonA = layerA.toGeoJSON();
    var geojsonB = layerB.toGeoJSON();

    // Инвертируем координаты геометрий
    invertCoordinates(geojsonA);
    invertCoordinates(geojsonB);

    console.log('GeoJSON первого объекта после инвертирования координат:', geojsonA);
    console.log('GeoJSON второго объекта после инвертирования координат:', geojsonB);

    // Преобразование GeoJSON в геометрии JSTS
    var geometryA, geometryB;
    try {
        geometryA = reader.read(geojsonA.geometry);
        geometryB = reader.read(geojsonB.geometry);
    } catch (error) {
        console.error('Ошибка при чтении геометрий с помощью JSTS:', error);
        alert('Ошибка при чтении геометрий. Проверьте корректность геометрий.');
        return;
    }

    console.log('Геометрия A:', geometryA);
    console.log('Геометрия B:', geometryB);

    // Выполнение операции вычитания
    var differenceGeometry;
    try {
        differenceGeometry = geometryA.difference(geometryB);
    } catch (error) {
        console.error('Ошибка при вычитании объектов:', error);
        alert('Не удалось выполнить вычитание. Проверьте корректность геометрий.');
        return;
    }

    console.log('Результат вычитания (геометрия):', differenceGeometry);

    // Проверка, что результат не пустой
    if (differenceGeometry.isEmpty()) {
        alert('Результат вычитания пуст.');
        return;
    }

    // Проверка валидности результирующей геометрии
    if (!differenceGeometry.isValid()) {
        alert('Результирующая геометрия некорректна.');
        return;
    }

    // Преобразование результата обратно в GeoJSON
    var differenceFeature = {
        type: 'Feature',
        properties: {},
        geometry: writer.write(differenceGeometry)
    };

    console.log('GeoJSON результата вычитания перед инвертированием координат:', differenceFeature);

    // Инвертируем координаты обратно
    invertCoordinates(differenceFeature);

    console.log('GeoJSON результата вычитания после инвертирования координат:', differenceFeature);

    // Запрашиваем название слоя для результата вычитания
    var newLayerName = prompt('Введите название слоя для результата вычитания:');
    if (newLayerName) {
        var targetLayer;
        if (layers[newLayerName]) {
            targetLayer = layers[newLayerName];
        } else {
            targetLayer = addNewLayer(newLayerName);
        }

        // Удаляем старый объект и добавляем новый с вырезанной геометрией
        if (layerA.parentLayerGroup) {
            layerA.parentLayerGroup.removeLayer(layerA);
        } else {
            map.removeLayer(layerA);
        }

        var newLayer = L.geoJSON(differenceFeature, {
            onEachFeature: function(feature, layer) {
                addClickHandler(layer);
                layer.parentLayerGroup = targetLayer; // Сохраняем ссылку на родительский слой
            }
        });

        newLayer.eachLayer(function(layer) {
            targetLayer.addLayer(layer);
        });
    } else {
        alert('Операция отменена.');
        return;
    }

    console.log('Новый слой с результатом вычитания добавлен на карту.');

    // Сбрасываем выбор второго объекта
    layerB.setStyle({ color: '#3388ff' });
    layerB.selected = false;

    // Очищаем массив порядка выбора
    selectedLayersOrder = [];
});

// Удаление выбранных объектов с возможностью отмены
document.getElementById('delete-object-btn').addEventListener('click', function() {
    if (selectedLayersOrder.length === 0) {
        alert('Выберите объект(ы) для удаления.');
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

        // Сохраняем удалённый объект
        deletedObjects.push({
            layer: layer,
            parentLayerGroup: layer.parentLayerGroup,
            time: Date.now()
        });
    });

    // Показываем уведомление с возможностью отмены
    showUndoNotification();
});

// Функция для отображения уведомления об удалении с кнопкой отмены
function showUndoNotification() {
    var undoContainer = document.createElement('div');
    undoContainer.id = 'undo-container';
    undoContainer.style.position = 'absolute';
    undoContainer.style.bottom = '20px';
    undoContainer.style.left = '20px';
    undoContainer.style.padding = '10px';
    undoContainer.style.backgroundColor = 'rgba(0, 0, 0, 0.7)';
    undoContainer.style.color = '#fff';
    undoContainer.style.borderRadius = '5px';
    undoContainer.style.zIndex = '1000';

    undoContainer.innerHTML = 'Объекты удалены. <button id="undo-button">Отменить</button>';

    document.body.appendChild(undoContainer);

    var undoButton = document.getElementById('undo-button');
    undoButton.addEventListener('click', function() {
        // Восстанавливаем удалённые объекты
        deletedObjects.forEach(function(item) {
            if (item.parentLayerGroup) {
                item.parentLayerGroup.addLayer(item.layer);
            } else {
                map.addLayer(item.layer);
            }
        });

        // Очищаем массив удалённых объектов
        deletedObjects = [];

        // Убираем уведомление
        document.body.removeChild(undoContainer);

        clearTimeout(undoTimeout);
    });

    // Удаляем возможность отмены через 15 секунд
    var undoTimeout = setTimeout(function() {
        deletedObjects = [];
        if (document.body.contains(undoContainer)) {
            document.body.removeChild(undoContainer);
        }
    }, 15000);
}
