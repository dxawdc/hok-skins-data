'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  deriveFirstObtainType,
  normalizeFirstObtainType,
} = require('../api/admin')._private;

test('首发获取方式：钻石夺宝归类为免费', () => {
  assert.equal(deriveFirstObtainType('钻石夺宝', 0), '免费');
});

test('首发获取方式：战令按价值点数区分免费和付费', () => {
  assert.equal(deriveFirstObtainType('S42赛季/战令活动', 0), '战令-免费');
  assert.equal(deriveFirstObtainType('S41赛季史诗 荣耀战令1级', 388), '战令-付费');
  assert.equal(deriveFirstObtainType('战令', null), '战令-付费');
});

test('首发获取方式：旧战令值会按当前规则重新初始化', () => {
  assert.equal(normalizeFirstObtainType('战令', '战令', 0), '战令-免费');
});
