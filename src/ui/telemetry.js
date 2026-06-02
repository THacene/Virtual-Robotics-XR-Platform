import * as THREE from "https://cdn.jsdelivr.net/npm/three@0.160/build/three.module.js";

const _tcpWP = new THREE.Vector3();

/**
 * دالة مساعدة لتعيين نص عنصر DOM بأمان
 * تتجنب الأخطاء إذا كان العنصر غير موجود أو تغير ID
 * @param {string} id - معرّف العنصر
 * @param {*} val - القيمة المراد تعيينها (سيتم تحويلها إلى string)
 */
const set = (id, val) => {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
};

export function updateTelemetry({ jCurrent, scene, physicsCtrl, fingerSensors }) {
  const j = jCurrent;
  const angToBar = (v, min, max) => ((v - min) / (max - min) * 100).toFixed(1) + '%';

  const joints = [
    { val: 'tBaseVal',     bar: 'tBaseBar',    v: j.base,     min:-180, max:180 },
    { val: 'tShoulderVal', bar: 'tShoulderBar', v: j.shoulder, min:-80,  max:85  },
    { val: 'tElbowVal',    bar: 'tElbowBar',    v: j.elbow,    min:-90,  max:90  },
    { val: 'tWristVal',    bar: 'tWristBar',    v: j.wrist,    min:-180, max:180 },
  ];
  for (const jj of joints) {
    set(jj.val, Math.round(jj.v) + '°');
    const bEl = document.getElementById(jj.bar);
    if (bEl) bEl.style.width = angToBar(jj.v, jj.min, jj.max);
  }

  const openSlider = document.getElementById('sOpen');
  if (openSlider) set('tGripOpen', openSlider.value + ' mm');

  const bp = physicsCtrl?.body?.position;
  if (bp) {
    set('tBoxX', bp.x.toFixed(2));
    set('tBoxY', bp.y.toFixed(2));
    set('tBoxZ', bp.z.toFixed(2));
  }

  const tcpObj = scene.getObjectByName('tcp');
  if (tcpObj) {
    tcpObj.getWorldPosition(_tcpWP);
    set('tTcpX', _tcpWP.x.toFixed(2));
    set('tTcpY', _tcpWP.y.toFixed(2));
    set('tTcpZ', _tcpWP.z.toFixed(2));
    if (bp) {
      const dist = _tcpWP.distanceTo(new THREE.Vector3(bp.x, bp.y, bp.z));
      const distEl = document.getElementById('tBoxDist');
      if (distEl) {
        set('tBoxDist', dist.toFixed(2) + ' m');
        distEl.style.color = dist < 1.0 ? 'var(--f)' : dist < 2.5 ? 'var(--warn)' : 'var(--dim)';
      }
    }
  }

  if (fingerSensors?.left && fingerSensors?.right) {
    const ls = fingerSensors.left.getState();
    const rs = fingerSensors.right.getState();
    const setPoint = (elId, point) => {
      const el = document.getElementById(elId);
      if (!el) return;
      if (point?.isTouching) {
        el.textContent = `ON  ${Math.round(point.touchForce * 100)}%`;
        el.style.color = 'var(--sens)';
      } else {
        el.textContent = 'OFF';
        el.style.color = '#aaa';
      }
    };
    setPoint('tLTip',  ls.points.find(p => p.name === 'tip'));
    setPoint('tLMid',  ls.points.find(p => p.name === 'middle'));
    setPoint('tLBase', ls.points.find(p => p.name === 'base'));
    setPoint('tRTip',  rs.points.find(p => p.name === 'tip'));
    setPoint('tRMid',  rs.points.find(p => p.name === 'middle'));
    setPoint('tRBase', rs.points.find(p => p.name === 'base'));
    const avgForce = ((ls.touchForce + rs.touchForce) / 2) * 100;
    document.getElementById('tForceBar').style.width = avgForce.toFixed(1) + '%';
    set('tForceVal', Math.round(avgForce) + '%');
    document.getElementById('tLDot').style.background = ls.isTouching ? 'var(--sens)' : '#ccc';
    document.getElementById('tRDot').style.background = rs.isTouching ? 'var(--sens)' : '#ccc';
  }

  const stEl = document.getElementById('tStatus');
  const sbEl = document.getElementById('sb');
  if (stEl && sbEl) {
    const cls = sbEl.className;
    stEl.textContent  = sbEl.textContent;
    stEl.style.color  = cls === 'ok' ? 'var(--f)' : cls === 'warn' ? 'var(--warn)' : cls === 'crit' ? 'var(--crit)' : 'var(--dim)';
    stEl.style.background  = cls === 'ok' ? '#edfaf4' : cls === 'warn' ? '#fff8e6' : cls === 'crit' ? '#fff0f2' : '#f8fafc';
    stEl.style.borderColor = stEl.style.color;
  }
}