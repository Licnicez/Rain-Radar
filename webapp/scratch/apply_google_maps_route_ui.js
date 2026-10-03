const fs = require('fs');
const path = require('path');

const appFile = path.resolve('src/App.tsx');
let content = fs.readFileSync(appFile, 'utf8');

// 1. Add Route Callout Badges generator functions
const routeBadgeHelpers = `// สร้าง Marker ป้ายฟองสบู่คำนวณเวลาเดินทางบนเส้นทางสไตล์ Google Maps
const createSelectedRouteBadge = (route: RouteOption) => {
  const isRain = route.maxRainProbability > 30;
  return L.divIcon({
    className: 'route-badge-selected',
    html: \`
      <div style="position: relative; transform: translate(-50%, -100%); cursor: pointer; pointer-events: auto;">
        <div style="background: #1a73e8; color: #ffffff; padding: 6px 12px; border-radius: 14px; box-shadow: 0 4px 18px rgba(26,115,232,0.45); font-family: 'Prompt', sans-serif; white-space: nowrap; border: 2.5px solid #ffffff; display: flex; flex-direction: column; align-items: center; min-width: 95px;">
          <div style="display: flex; align-items: center; gap: 5px; font-weight: 900; font-size: 0.88rem;">
            <span>\${route.durationFormatted || route.durationMin + ' นาที'}</span>
            <span>\${isRain ? '🌧️' : '🍃'}</span>
          </div>
          <div style="font-size: 0.72rem; opacity: 0.95; font-weight: 700; margin-top: 1px;">
            \${route.hasTollway ? 'Tolls (ทางด่วน)' : 'No tolls (ทางราบ)'}
          </div>
        </div>
        <!-- Speech Bubble Arrow -->
        <div style="width: 0; height: 0; border-left: 7px solid transparent; border-right: 7px solid transparent; border-top: 8px solid #1a73e8; margin: 0 auto;"></div>
      </div>
    \`,
    iconSize: [0, 0],
    iconAnchor: [0, 0],
  });
};

const createAltRouteBadge = (route: RouteOption) => {
  const isRain = route.maxRainProbability > 30;
  return L.divIcon({
    className: 'route-badge-alt',
    html: \`
      <div style="position: relative; transform: translate(-50%, -100%); cursor: pointer; pointer-events: auto;">
        <div style="background: #ffffff; color: #3c4043; padding: 6px 11px; border-radius: 14px; box-shadow: 0 4px 14px rgba(0,0,0,0.18); font-family: 'Prompt', sans-serif; white-space: nowrap; border: 1.5px solid #dadce0; display: flex; flex-direction: column; align-items: center; min-width: 90px;">
          <div style="display: flex; align-items: center; gap: 5px; font-weight: 800; font-size: 0.85rem; color: #202124;">
            <span>\${route.durationFormatted || route.durationMin + ' นาที'}</span>
            <span>\${isRain ? '🌧️' : '🍃'}</span>
          </div>
          <div style="font-size: 0.7rem; color: #5f6368; font-weight: 600; margin-top: 1px;">
            \${route.hasTollway ? 'Tolls' : 'No tolls'}
          </div>
        </div>
        <!-- Speech Bubble Arrow -->
        <div style="width: 0; height: 0; border-left: 6px solid transparent; border-right: 6px solid transparent; border-top: 7px solid #ffffff; margin: 0 auto;"></div>
      </div>
    \`,
    iconSize: [0, 0],
    iconAnchor: [0, 0],
  });
};
`;

if (!content.includes('createSelectedRouteBadge')) {
  content = content.replace(
    '// สร้างไอคอนรูปรถ/ลูกศรนำทางแบบ Dynamic',
    `${routeBadgeHelpers}\n// สร้างไอคอนรูปรถ/ลูกศรนำทางแบบ Dynamic`
  );
}

// 2. Add styles for radar scanning animation
const radarAnimationStyles = `
      {/* CSS Animation สำหรับเรดาร์สแกนสภาพอากาศ */}
      <style>{\`
        @keyframes radarSpin {
          0% { transform: rotate(0deg); }
          100% { transform: rotate(360deg); }
        }
        @keyframes scanProgressAnim {
          0% { width: 10%; transform: translateX(-10%); }
          50% { width: 80%; transform: translateX(15%); }
          100% { width: 100%; transform: translateX(0%); }
        }
        @keyframes radarPulseRing {
          0% { transform: scale(0.7); opacity: 0.8; }
          100% { transform: scale(1.6); opacity: 0; }
        }
      \`}</style>
`;

if (!content.includes('radarSpin')) {
  content = content.replace(
    `    <div\n      style={{\n        position: 'relative',\n        height: '100vh',`,
    `    <div\n      style={{\n        position: 'relative',\n        height: '100vh',`
  );
  content = content.replace(
    `      {/* ================= แผนที่เต็มจอ (Full Screen Interactive Map) ================= */}`,
    `${radarAnimationStyles}\n      {/* ================= แผนที่เต็มจอ (Full Screen Interactive Map) ================= */}`
  );
}

// 3. Update polylines and add Route Callout Badges on the map
const oldPolylineSectionRegex = /\{\/\* เส้นทางทางเลือกสำรอง \(แสดงเป็นเส้นประสีเทา สามารถคลิกเพื่อเลือกได้\) \*\/\}[\s\S]*?\{\/\* จุดตรวจสอบสภาพอากาศ \(Checkpoints\) \*\/\}/;

const newRouteMapLayers = `{/* ================= เส้นทางทางเลือกสไตล์ Google Maps ================= */}
          {data?.routes && data.routes.map((rt, idx) => {
            const isSelected = selectedRouteIndex === idx;
            const positions = rt.geometry.coordinates.map(([lon, lat]: [number, number]) => [lat, lon] as [number, number]);
            if (positions.length === 0) return null;

            // พิกัดกึ่งกลางเส้นทางสำหรับวางป้ายเวลาเดินทาง (Speech Bubble)
            const midIndex = Math.floor(positions.length * 0.45);
            const badgePosition = positions[midIndex];

            return (
              <React.Fragment key={\`route-group-\${rt.id}\`}>
                {/* เส้นทาง Polylines */}
                <Polyline
                  positions={positions}
                  color={isSelected ? '#1a73e8' : '#80868b'}
                  weight={isSelected ? 7 : 6}
                  opacity={isSelected ? 0.95 : 0.75}
                  zIndexOffset={isSelected ? 200 : 100}
                  eventHandlers={{
                    click: () => setSelectedRouteIndex(rt.id),
                  }}
                />

                {/* ป้ายฟองสบู่แสดงเวลาเดินทางบนเส้นทาง (Google Maps Callout Bubble) */}
                {badgePosition && (
                  <Marker
                    position={badgePosition}
                    icon={isSelected ? createSelectedRouteBadge(rt) : createAltRouteBadge(rt)}
                    zIndexOffset={isSelected ? 1000 : 500}
                    eventHandlers={{
                      click: () => setSelectedRouteIndex(rt.id),
                    }}
                  />
                )}
              </React.Fragment>
            );
          })}

          {/* จุดตรวจสอบสภาพอากาศ (Checkpoints) */}`;

content = content.replace(oldPolylineSectionRegex, newRouteMapLayers);

// 4. Update the bottom area: Replace Carousel with Google Maps Bottom Route Sheet + Start Trip Button
const oldCarouselRegex = /\{\/\* ================= CAROUSEL: การ์ดเลือกเส้นทาง \(Select Distance Cards สไตล์มินิมอล\) ================= \*\/\}[\s\S]*?\{\/\* ================= FLOATING GISTDA FLOOD CONTROLLER/;

const newGoogleMapsBottomCard = `{/* ================= FLOATING GISTDA FLOOD CONTROLLER`;

content = content.replace(oldCarouselRegex, newGoogleMapsBottomCard);

// 5. Add Google Maps Bottom Sheet above bottom dock when route is selected
const bottomDockAnchor = `      {/* ================= BOTTOM FLOATING ACTION DOCK (Iconify Buttons) ================= */}`;

const googleMapsRouteSheet = `      {/* ================= GOOGLE MAPS ROUTE SUMMARY SHEET (สไตล์ Google Maps ในแบบ) ================= */}
      {!isTracking && activeRoute && (
        <div
          style={{
            position: 'absolute',
            bottom: 'max(84px, env(safe-area-inset-bottom) + 68px)',
            left: '16px',
            right: '16px',
            zIndex: 110,
            display: 'flex',
            justifyContent: 'center',
            pointerEvents: 'none',
          }}
        >
          <div
            style={{
              pointerEvents: 'auto',
              backgroundColor: '#ffffff',
              borderRadius: '24px',
              padding: '16px 18px',
              boxShadow: '0 12px 36px rgba(0, 0, 0, 0.16), 0 2px 8px rgba(0,0,0,0.06)',
              border: '1px solid #e2e8f0',
              width: '100%',
              maxWidth: '400px',
              display: 'flex',
              flexDirection: 'column',
              gap: '10px',
            }}
          >
            {/* Grab handle */}
            <div style={{ width: '36px', height: '4px', backgroundColor: '#e2e8f0', borderRadius: '2px', alignSelf: 'center', marginBottom: '2px' }} />

            {/* แถวบน: เวลาเดินทาง และ ระยะทาง ขนาดใหญ่ */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
              <div>
                <span style={{ fontSize: '1.45rem', fontWeight: 900, color: '#1a73e8' }}>
                  {activeRoute.durationFormatted || formatDuration(activeRoute.durationMin)}
                </span>
                <span style={{ fontSize: '0.95rem', fontWeight: 700, color: '#5f6368', marginLeft: '6px' }}>
                  ({activeRoute.distanceKm} กม.)
                </span>
              </div>

              {/* ป้ายสภาพอากาศ */}
              <span
                onClick={() => setActiveSheet('SUMMARY')}
                style={{
                  fontSize: '0.74rem',
                  fontWeight: 800,
                  padding: '3px 8px',
                  borderRadius: '12px',
                  backgroundColor: activeRoute.maxRainProbability > 30 ? '#fee2e2' : '#ecfdf5',
                  color: activeRoute.maxRainProbability > 30 ? '#dc2626' : '#059669',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '4px',
                }}
              >
                <Icon icon={activeRoute.maxRainProbability > 30 ? 'solar:cloud-rain-bold-duotone' : 'solar:sun-2-bold-duotone'} width="14" height="14" />
                {activeRoute.maxRainProbability > 30 ? \`ฝน \${activeRoute.maxRainProbability}%\` : 'ถนนแห้ง'}
              </span>
            </div>

            {/* รายละเอียดทางด่วน และ คำแนะนำประหยัดพลังงาน/เส้นทาง */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '0.78rem', color: '#4b5563' }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: '4px', fontWeight: 700, color: activeRoute.hasTollway ? '#d97706' : '#059669' }}>
                <Icon icon={activeRoute.hasTollway ? 'solar:road-bold-duotone' : 'solar:shield-check-bold'} width="14" height="14" />
                {activeRoute.hasTollway ? \`ขึ้นทางด่วน (~ \${activeRoute.tollDistanceKm} กม.)\` : 'ไม่ขึ้นทางด่วน (ทางราบ)'}
              </span>
              <span>•</span>
              <span style={{ color: '#6b7280', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {activeRoute.name}
              </span>
            </div>

            {/* ปุ่มกด เริ่มเดินทาง (Google Maps Navigation Style) */}
            <div style={{ display: 'flex', gap: '8px', marginTop: '4px' }}>
              <button
                onClick={toggleTracking}
                style={{
                  flex: 1,
                  backgroundColor: '#1a73e8',
                  color: '#ffffff',
                  border: 'none',
                  borderRadius: '18px',
                  padding: '11px 16px',
                  fontSize: '0.92rem',
                  fontWeight: 800,
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '6px',
                  boxShadow: '0 4px 14px rgba(26,115,232,0.35)',
                  transition: 'all 0.15s ease',
                }}
              >
                <Icon icon="solar:navigation-bold" width="18" height="18" />
                <span>เริ่มเดินทาง</span>
              </button>

              <button
                onClick={() => setActiveSheet('SUMMARY')}
                style={{
                  backgroundColor: '#f1f5f9',
                  color: '#334155',
                  border: 'none',
                  borderRadius: '18px',
                  padding: '11px 14px',
                  fontSize: '0.85rem',
                  fontWeight: 700,
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '4px',
                }}
                title="ดูรายงานสภาพอากาศและจุดตรวจ"
              >
                <Icon icon="solar:cloud-rain-bold-duotone" width="16" height="16" />
                <span>ดูฝน</span>
              </button>
            </div>
          </div>
        </div>
      )}
`;

content = content.replace(bottomDockAnchor, `${googleMapsRouteSheet}\n${bottomDockAnchor}`);

// 6. Add Scanning Animation HUD (หน้าจอเรดาร์แอนิเมชันระหว่างรอสแกน)
const scanningOverlay = `      {/* ================= RADAR SCANNING ANIMATION OVERLAY (อนิเมชั่นรอสแกนเส้นทาง) ================= */}
      {loading && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            zIndex: 3000,
            backgroundColor: 'rgba(15, 23, 42, 0.68)',
            backdropFilter: 'blur(10px)',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '24px',
            color: '#ffffff',
          }}
        >
          {/* Circular Radar Screen */}
          <div
            style={{
              position: 'relative',
              width: '180px',
              height: '180px',
              borderRadius: '50%',
              border: '2px solid rgba(56, 189, 248, 0.45)',
              boxShadow: '0 0 35px rgba(14, 165, 233, 0.4), inset 0 0 35px rgba(14, 165, 233, 0.25)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              overflow: 'hidden',
              background: 'radial-gradient(circle, rgba(14, 165, 233, 0.2) 0%, rgba(15, 23, 42, 0.85) 100%)',
            }}
          >
            {/* วงแหวนคลื่นเรดาร์ 3 ชั้น */}
            <div style={{ position: 'absolute', width: '120px', height: '120px', borderRadius: '50%', border: '1px dashed rgba(56, 189, 248, 0.4)' }} />
            <div style={{ position: 'absolute', width: '60px', height: '60px', borderRadius: '50%', border: '1px solid rgba(56, 189, 248, 0.5)' }} />

            {/* เส้นตัดแกนกากบาท */}
            <div style={{ position: 'absolute', width: '100%', height: '1px', background: 'rgba(56, 189, 248, 0.3)' }} />
            <div style={{ position: 'absolute', height: '100%', width: '1px', background: 'rgba(56, 189, 248, 0.3)' }} />

            {/* ลำแสงสแกนเรดาร์หมุน 360 องศา (Radar Sweep Beam) */}
            <div
              style={{
                position: 'absolute',
                inset: 0,
                borderRadius: '50%',
                background: 'conic-gradient(from 0deg, rgba(56, 189, 248, 0) 0deg, rgba(56, 189, 248, 0) 260deg, rgba(56, 189, 248, 0.65) 360deg)',
                animation: 'radarSpin 1.6s linear infinite',
              }}
            />

            {/* แกนกลางเรดาร์เปล่งแสง */}
            <div
              style={{
                position: 'relative',
                width: '46px',
                height: '46px',
                borderRadius: '50%',
                backgroundColor: '#0284c7',
                boxShadow: '0 0 24px #38bdf8',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                border: '2px solid #ffffff',
              }}
            >
              <Icon icon="solar:radar-2-bold" width="26" height="26" className="animate-spin text-white" />
            </div>
          </div>

          {/* ข้อความสถานะการสแกน */}
          <div style={{ marginTop: '24px', textAlign: 'center', maxWidth: '320px' }}>
            <div style={{ fontSize: '1.15rem', fontWeight: 900, color: '#f8fafc', letterSpacing: '0.3px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px' }}>
              <span style={{ display: 'inline-block', width: '10px', height: '10px', borderRadius: '50%', backgroundColor: '#38bdf8', animation: 'ping 1.5s cubic-bezier(0, 0, 0.2, 1) infinite' }} />
              <span>กำลังสแกนสภาพอากาศเส้นทาง</span>
            </div>
            <div style={{ fontSize: '0.82rem', color: '#94a3b8', marginTop: '6px', lineHeight: 1.4 }}>
              เชื่อมต่อเรดาร์ฝนและดาวเทียม GISTDA ตรวจสอบสภาพถนนตลอดแนว...
            </div>

            {/* แถบ Progress Bar เคลื่อนไหว */}
            <div
              style={{
                marginTop: '16px',
                width: '210px',
                height: '5px',
                backgroundColor: 'rgba(255, 255, 255, 0.15)',
                borderRadius: '3px',
                overflow: 'hidden',
                margin: '16px auto 0 auto',
              }}
            >
              <div
                style={{
                  height: '100%',
                  background: 'linear-gradient(90deg, #38bdf8, #818cf8, #38bdf8)',
                  backgroundSize: '200% 100%',
                  animation: 'scanProgressAnim 1.6s ease-in-out infinite',
                  borderRadius: '3px',
                }}
              />
            </div>
          </div>
        </div>
      )}
`;

const rootDivEnd = `    </div>\n  );\n}`;
content = content.replace(rootDivEnd, `${scanningOverlay}\n${rootDivEnd}`);

fs.writeFileSync(appFile, content, 'utf8');
console.log('Updated ' + appFile);

const nestedAppFile = path.resolve('Rain-Radar/webapp/src/App.tsx');
if (fs.existsSync(path.dirname(nestedAppFile))) {
  fs.writeFileSync(nestedAppFile, content, 'utf8');
  console.log('Updated ' + nestedAppFile);
}
