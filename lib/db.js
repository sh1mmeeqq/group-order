'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite'); // встроенный SQLite, Node >= 22.5

function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON');
  if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
  db.exec(fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8'));
  seed(db);
  return db;
}

// Демо-ресторан. Цены в копейках. «Четыре сыра» намеренно недоступна,
// чтобы можно было проверить состояние «нет в наличии» из ТЗ (раздел 5).
function seed(db) {
  if (db.prepare('SELECT COUNT(*) n FROM restaurants').get().n > 0) return;
  db.exec('BEGIN');
  try {
    db.prepare('INSERT INTO restaurants (id, name, delivery_fee, service_fee_pct) VALUES (1, ?, ?, ?)')
      .run('Паста & Бао (демо)', 19900, 5);
    const ins = db.prepare(
      'INSERT INTO menu_items (restaurant_id, category, name, description, weight, price, available, sort) VALUES (1, ?, ?, ?, ?, ?, ?, ?)'
    );
    const menu = [
      ['Закуски', 'Хумус с лепёшкой', 'Нутовая паста, оливковое масло, тёплая лепёшка', '220 г', 290, 1],
      ['Закуски', 'Цезарь с курицей', 'Романо, пармезан, соус цезарь, гренки', '250 г', 420, 1],
      ['Закуски', 'Крылья BBQ', '8 штук, соус барбекю, сельдерей', '320 г', 480, 1],
      ['Пицца', 'Маргарита', 'Томаты, моцарелла, базилик', '30 см', 520, 1],
      ['Пицца', 'Пепперони', 'Пепперони, моцарелла, томатный соус', '30 см', 640, 1],
      ['Пицца', 'Четыре сыра', 'Моцарелла, горгонзола, пармезан, чеддер', '30 см', 690, 0],
      ['Паста', 'Карбонара', 'Гуанчале, желток, пекорино', '300 г', 540, 1],
      ['Паста', 'Болоньезе', 'Говяжий рагу, томаты, пармезан', '300 г', 520, 1],
      ['Паста', 'Паста с креветками', 'Тигровые креветки, чеснок, сливки', '310 г', 760, 1],
      ['Бао', 'Бао со свининой', 'Томлёная свинина, пикули, кинза', '2 шт.', 330, 1],
      ['Бао', 'Бао с тофу', 'Хрустящий тофу, кимчи, кунжут', '2 шт.', 290, 1],
      ['Напитки', 'Лимонад домашний', 'Лимон, мята', '0,4 л', 250, 1],
      ['Напитки', 'Морс клюквенный', 'Клюква, мёд', '0,4 л', 220, 1],
      ['Напитки', 'Кола', 'Классическая', '0,33 л', 150, 1],
      ['Десерты', 'Тирамису', 'Маскарпоне, савоярди, кофе', '140 г', 350, 1],
      ['Десерты', 'Чизкейк', 'Нью-йоркский, ягодный соус', '130 г', 380, 1],
    ];
    menu.forEach(([cat, name, desc, weight, rub, avail], i) =>
      ins.run(cat, name, desc, weight, rub * 100, avail, i));
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

module.exports = { openDb };

