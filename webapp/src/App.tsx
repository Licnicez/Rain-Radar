import React, { useState, useEffect, useRef } from 'react';
import { MapContainer, TileLayer, Polyline, CircleMarker, Popup, useMap } from 'react-leaflet';

interface Checkpoint {
  id: number;
  lat: number;
  lon: number;
  rainProbability: number;
  rainAmountMm: number;
  status: 'SAFE' | 'WARNING' | 'DANGER';
}

interface RouteAnalysis {
  summary: {
    status: 'SAFE' | 'WARNING' | 'DANGER';
    totalDistanceKm: string;
    totalDurationMin: number;
    totalCheckpoints: number;
    rainPointsCount: number;
    maxRainProbability: number;
    recommendation: string;
  };
  routeGeometry: {
    coordinates: [number, number][]; // [lon, lat]
  };
  checkpoints: Checkpoint[];
}

interface PlaceSuggestion {
  place_id: number | string;
  display_name: string;
  lat: string;
  lon: string;
  name?: string;
}

// Component ควบคุมมุมมองของแผนที่อัตโนมัติ (Center & Fit Bounds)
function MapController({
  origin,
  destination,
  routeCoords,
}: {
  origin: { lat: number; lon: number } | null;
  destination: { lat: number; lon: number } | null;
  routeCoords: [number, number][];
}) {
  const map = useMap();

  useEffect(() => {
    if (routeCoords && routeCoords.length > 0) {
      map.fitBounds(routeCoords, { padding: [50, 50], maxZoom: 14 });
    } else if (origin && destination && (origin.lat !== destination.lat || origin.lon !== destination.lon)) {
      map.fitBounds(
        [
          [origin.lat, origin.lon],
          [destination.lat, destination.lon],
        ],
        { padding: [70, 70], maxZoom: 14 }
      );
    } else if (origin) {
      map.setView([origin.lat, origin.lon], 13);
    }
  }, [routeCoords, origin?.lat, origin?.lon, destination?.lat, destination?.lon]);

  return null;
}

export function App() {
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<RouteAnalysis | null>(null);

  // พิกัดต้นทางและปลายทาง (ค่าเริ่มต้น: จตุจักร -> ฟิวเจอร์พาร์ครังสิต)
  const [origin, setOrigin] = useState({ lat: 13.8027, lon: 100.5539 });
  const [originName, setOriginName] = useState('BTS หมอชิต / จตุจักร');

  const [destination, setDestination] = useState({ lat: 13.9892, lon: 100.6177 });
  const [destinationName, setDestinationName] = useState('ฟิวเจอร์พาร์ค รังสิต');

  // สถานะการค้นหา Geocoding
  const [originSuggestions, setOriginSuggestions] = useState<PlaceSuggestion[]>([]);
  const [destSuggestions, setDestSuggestions] = useState<PlaceSuggestion[]>([]);
  const [isSearchingOrigin, setIsSearchingOrigin] = useState(false);
  const [isSearchingDest, setIsSearchingDest] = useState(false);
  const [showOriginDropdown, setShowOriginDropdown] = useState(false);
  const [showDestDropdown, setShowDestDropdown] = useState(false);

  // สถานะ GPS
  const [isGpsLoading, setIsGpsLoading] = useState(false);

  // แสดง/ซ่อนช่องแก้ไขตัวเลขพิกัดแบบ Manual
  const [showManualCoords, setShowManualCoords] = useState(false);

  const originInputRef = useRef<HTMLDivElement>(null);
  const destInputRef = useRef<HTMLDivElement>(null);

  // ฟังก์ชันค้นหาสถานที่ผ่าน OpenStreetMap Nominatim API
  const searchPlaces = async (query: string): Promise<PlaceSuggestion[]> => {
    if (!query || query.trim().length < 2) return [];
    try {
      const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(
        query.trim()
      )}&limit=5&countrycodes=th&addressdetails=1`;
      const res = await fetch(url, {
        headers: {
          'Accept-Language': 'th,en',
        },
      });
      if (!res.ok) return [];
      return await res.json();
    } catch (err) {
      console.error('Error fetching Nominatim:', err);
      return [];
    }
  };

  // Debounced Search สำหรับ Origin
  useEffect(() => {
    if (!showOriginDropdown) return;
    const timer = setTimeout(async () => {
      if (originName && originName.length >= 2 && !originName.startsWith('📍')) {
        setIsSearchingOrigin(true);
        const results = await searchPlaces(originName);
        setOriginSuggestions(results);
        setIsSearchingOrigin(false);
      }
    }, 450);

    return () => clearTimeout(timer);
  }, [originName, showOriginDropdown]);

  // Debounced Search สำหรับ Destination
  useEffect(() => {
    if (!showDestDropdown) return;
    const timer = setTimeout(async () => {
      if (destinationName && destinationName.length >= 2) {
        setIsSearchingDest(true);
        const results = await searchPlaces(destinationName);
        setDestSuggestions(results);
        setIsSearchingDest(false);
      }
    }, 450);

    return () => clearTimeout(timer);
  }, [destinationName, showDestDropdown]);

  // ปิด dropdown เมื่อคลิกนอกกล่องค้นหา
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (originInputRef.current && !originInputRef.current.contains(e.target as Node)) {
        setShowOriginDropdown(false);
      }
      if (destInputRef.current && !destInputRef.current.contains(e.target as Node)) {
        setShowDestDropdown(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // ฟังก์ชันดึงพิกัดปัจจุบันด้วย Browser Geolocation API
  const handleGetCurrentLocation = () => {
    if (!navigator.geolocation) {
      alert('เบราว์เซอร์ของคุณไม่รองรับการระบุตำแหน่ง GPS');
      return;
    }

    setIsGpsLoading(true);
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const lat = Number(pos.coords.latitude.toFixed(6));
        const lon = Number(pos.coords.longitude.toFixed(6));
        setOrigin({ lat, lon });
        setOriginName('📍 ตำแหน่งปัจจุบันของคุณ');
        setShowOriginDropdown(false);
        setIsGpsLoading(false);

        // Reverse Geocoding เพื่อดึงชื่อสถานที่/ถนนจริง
        try {
          const revUrl = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}&zoom=16`;
          const res = await fetch(revUrl, {
            headers: { 'Accept-Language': 'th,en' },
          });
          const revData = await res.json();
          if (revData && revData.display_name) {
            const shortName = revData.display_name.split(',').slice(0, 3).join(', ');
            setOriginName(`📍 ${shortName}`);
          }
        } catch {
          // ใช้ชื่อ fallback เริ่มต้น
        }
      },
      (err) => {
        setIsGpsLoading(false);
        let errorMsg = 'ไม่สามารถดึงตำแหน่งปัจจุบันได้';
        if (err.code === err.PERMISSION_DENIED) {
          errorMsg = 'กรุณาอนุญาตการเข้าถึง Location Permission ในเบราว์เซอร์เพื่อใช้งาน GPS';
        } else if (err.code === err.POSITION_UNAVAILABLE) {
          errorMsg = 'สัญญาณพิกัด GPS ไม่พร้อมใช้งาน';
        } else if (err.code === err.TIMEOUT) {
          errorMsg = 'หมดเวลารอพิกัด GPS กรุณาลองใหม่อีกครั้ง';
        }
        alert(errorMsg);
      },
      {
        enableHighAccuracy: true,
        timeout: 10000,
        maximumAge: 0,
      }
    );
  };

  // เลือกสถานที่จากคำแนะนำของ Origin
  const handleSelectOrigin = (item: PlaceSuggestion) => {
    const lat = parseFloat(item.lat);
    const lon = parseFloat(item.lon);
    setOrigin({ lat, lon });
    // ตัดทอนชื่อให้อ่านง่าย
    const shortName = item.display_name.split(',').slice(0, 3).join(', ');
    setOriginName(shortName);
    setShowOriginDropdown(false);
  };

  // เลือกสถานที่จากคำแนะนำของ Destination
  const handleSelectDestination = (item: PlaceSuggestion) => {
    const lat = parseFloat(item.lat);
    const lon = parseFloat(item.lon);
    setDestination({ lat, lon });
    const shortName = item.display_name.split(',').slice(0, 3).join(', ');
    setDestinationName(shortName);
    setShowDestDropdown(false);
  };

  // ฟังก์ชันสลับต้นทางกับปลายทาง
  const handleSwapLocations = () => {
    const tempOrigin = { ...origin };
    const tempOriginName = originName;
    setOrigin(destination);
    setOriginName(destinationName);
    setDestination(tempOrigin);
    setDestinationName(tempOriginName);
  };

  // ยิง API ตรวจสอบสภาพอากาศตลอดเส้นทาง
  const handleCheckRain = async () => {
    setLoading(true);
    try {
      const res = await fetch('http://localhost:5000/api/analyze-route', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          origin,
          destination,
          sampleIntervalKm: 4,
        }),
      });
      const json = await res.json();
      if (json.status === 'success') {
        setData(json.data);
      } else {
        alert('API Error: ' + json.message);
      }
    } catch (err: any) {
      alert('เชื่อมต่อ API พอร์ต 5000 ไม่ได้ (ตรวจสอบว่ารัน server.js ไว้หรือยัง): ' + err.message);
    } finally {
      setLoading(false);
    }
  };

  const getStatusColor = (status: string) => {
    if (status === 'DANGER') return '#ef4444';
    if (status === 'WARNING') return '#f59e0b';
    return '#10b981';
  };

  const polylinePositions =
    data?.routeGeometry?.coordinates.map(([lon, lat]) => [lat, lon] as [number, number]) || [];

  return (
    <div style={{ display: 'flex', height: '100vh', width: '100vw', fontFamily: 'system-ui, -apple-system, sans-serif' }}>
      {/* Sidebar ด้านซ้าย */}
      <div
        style={{
          width: '400px',
          padding: '24px',
          borderRight: '1px solid #e5e7eb',
          overflowY: 'auto',
          boxSizing: 'border-box',
          backgroundColor: '#ffffff',
          display: 'flex',
          flexDirection: 'column',
          gap: '16px',
          boxShadow: '2px 0 10px rgba(0,0,0,0.03)',
          zIndex: 10,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <h2 style={{ fontSize: '1.35rem', fontWeight: 800, margin: 0, color: '#1e293b' }}>
            🏍️ Moto Rain Radar
          </h2>
          <span style={{ fontSize: '0.75rem', backgroundColor: '#e0f2fe', color: '#0369a1', padding: '3px 8px', borderRadius: '12px', fontWeight: 600 }}>
            v1.1
          </span>
        </div>

        {/* จุดเริ่มต้น (Origin) */}
        <div ref={originInputRef} style={{ position: 'relative' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
            <label style={{ fontSize: '0.85rem', color: '#334155', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '4px' }}>
              <span style={{ display: 'inline-block', width: '10px', height: '10px', borderRadius: '50%', backgroundColor: '#10b981' }}></span>
              จุดเริ่มต้น
            </label>
            <button
              onClick={handleGetCurrentLocation}
              disabled={isGpsLoading}
              style={{
                fontSize: '0.78rem',
                backgroundColor: isGpsLoading ? '#94a3b8' : '#ecfdf5',
                color: isGpsLoading ? '#ffffff' : '#047857',
                border: '1px solid #a7f3d0',
                borderRadius: '6px',
                padding: '4px 10px',
                cursor: isGpsLoading ? 'not-allowed' : 'pointer',
                fontWeight: 600,
                display: 'flex',
                alignItems: 'center',
                gap: '4px',
                transition: 'all 0.15s ease',
              }}
              title="ดึงพิกัดจาก GPS เครื่องของคุณ"
            >
              {isGpsLoading ? '⏳ กำลังหา GPS...' : '📍 ตำแหน่งปัจจุบัน'}
            </button>
          </div>

          <div style={{ position: 'relative' }}>
            <input
              type="text"
              placeholder="พิมพ์ชื่อสถานที่ เช่น BTS หมอชิต, สยาม..."
              value={originName}
              onChange={(e) => {
                setOriginName(e.target.value);
                setShowOriginDropdown(true);
              }}
              onFocus={() => setShowOriginDropdown(true)}
              style={{
                width: '100%',
                padding: '10px 36px 10px 12px',
                border: '1.5px solid #cbd5e1',
                borderRadius: '8px',
                fontSize: '0.92rem',
                boxSizing: 'border-box',
                outline: 'none',
              }}
            />
            {originName && (
              <button
                onClick={() => {
                  setOriginName('');
                  setOriginSuggestions([]);
                }}
                style={{
                  position: 'absolute',
                  right: '10px',
                  top: '50%',
                  transform: 'translateY(-50%)',
                  background: 'transparent',
                  border: 'none',
                  color: '#94a3b8',
                  cursor: 'pointer',
                  fontSize: '0.9rem',
                }}
              >
                ✕
              </button>
            )}
          </div>

          {/* Dropdown ผลลัพธ์การค้นหาต้นทาง */}
          {showOriginDropdown && (
            <div
              style={{
                position: 'absolute',
                top: '100%',
                left: 0,
                right: 0,
                backgroundColor: 'white',
                border: '1px solid #e2e8f0',
                borderRadius: '8px',
                boxShadow: '0 8px 20px rgba(0,0,0,0.12)',
                marginTop: '4px',
                zIndex: 1000,
                maxHeight: '220px',
                overflowY: 'auto',
              }}
            >
              {isSearchingOrigin && (
                <div style={{ padding: '10px', fontSize: '0.85rem', color: '#64748b', textAlign: 'center' }}>
                  🔍 กำลังค้นหาข้อมูล...
                </div>
              )}
              {!isSearchingOrigin && originSuggestions.length === 0 && originName.length >= 2 && (
                <div style={{ padding: '10px', fontSize: '0.85rem', color: '#94a3b8', textAlign: 'center' }}>
                  ไม่พบสถานที่ ลองพิมพ์ชื่อให้ชัดเจนขึ้น
                </div>
              )}
              {originSuggestions.map((item) => (
                <div
                  key={item.place_id}
                  onClick={() => handleSelectOrigin(item)}
                  style={{
                    padding: '8px 12px',
                    cursor: 'pointer',
                    fontSize: '0.85rem',
                    borderBottom: '1px solid #f1f5f9',
                    lineHeight: '1.3',
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = '#f8fafc')}
                  onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
                >
                  <div style={{ fontWeight: 600, color: '#1e293b' }}>
                    📍 {item.display_name.split(',')[0]}
                  </div>
                  <div style={{ fontSize: '0.75rem', color: '#64748b', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {item.display_name}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* ปุ่มสลับต้นทาง-ปลายทาง */}
        <div style={{ display: 'flex', justifyContent: 'center', margin: '-4px 0' }}>
          <button
            onClick={handleSwapLocations}
            style={{
              padding: '4px 12px',
              backgroundColor: '#f1f5f9',
              border: '1px solid #cbd5e1',
              borderRadius: '20px',
              fontSize: '0.8rem',
              color: '#475569',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
            }}
            title="สลับจุดเริ่มต้นและจุดหมาย"
          >
            ⇅ สลับจุดเริ่มต้นและปลายทาง
          </button>
        </div>

        {/* จุดปลายทาง (Destination) */}
        <div ref={destInputRef} style={{ position: 'relative' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
            <label style={{ fontSize: '0.85rem', color: '#334155', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '4px' }}>
              <span style={{ display: 'inline-block', width: '10px', height: '10px', borderRadius: '50%', backgroundColor: '#ef4444' }}></span>
              จุดปลายทาง
            </label>
          </div>

          <div style={{ position: 'relative' }}>
            <input
              type="text"
              placeholder="พิมพ์ชื่อสถานที่ปลายทาง เช่น ฟิวเจอร์พาร์ค..."
              value={destinationName}
              onChange={(e) => {
                setDestinationName(e.target.value);
                setShowDestDropdown(true);
              }}
              onFocus={() => setShowDestDropdown(true)}
              style={{
                width: '100%',
                padding: '10px 36px 10px 12px',
                border: '1.5px solid #cbd5e1',
                borderRadius: '8px',
                fontSize: '0.92rem',
                boxSizing: 'border-box',
                outline: 'none',
              }}
            />
            {destinationName && (
              <button
                onClick={() => {
                  setDestinationName('');
                  setDestSuggestions([]);
                }}
                style={{
                  position: 'absolute',
                  right: '10px',
                  top: '50%',
                  transform: 'translateY(-50%)',
                  background: 'transparent',
                  border: 'none',
                  color: '#94a3b8',
                  cursor: 'pointer',
                  fontSize: '0.9rem',
                }}
              >
                ✕
              </button>
            )}
          </div>

          {/* Dropdown ผลลัพธ์การค้นหาปลายทาง */}
          {showDestDropdown && (
            <div
              style={{
                position: 'absolute',
                top: '100%',
                left: 0,
                right: 0,
                backgroundColor: 'white',
                border: '1px solid #e2e8f0',
                borderRadius: '8px',
                boxShadow: '0 8px 20px rgba(0,0,0,0.12)',
                marginTop: '4px',
                zIndex: 1000,
                maxHeight: '220px',
                overflowY: 'auto',
              }}
            >
              {isSearchingDest && (
                <div style={{ padding: '10px', fontSize: '0.85rem', color: '#64748b', textAlign: 'center' }}>
                  🔍 กำลังค้นหาข้อมูล...
                </div>
              )}
              {!isSearchingDest && destSuggestions.length === 0 && destinationName.length >= 2 && (
                <div style={{ padding: '10px', fontSize: '0.85rem', color: '#94a3b8', textAlign: 'center' }}>
                  ไม่พบสถานที่ ลองพิมพ์ชื่อให้ชัดเจนขึ้น
                </div>
              )}
              {destSuggestions.map((item) => (
                <div
                  key={item.place_id}
                  onClick={() => handleSelectDestination(item)}
                  style={{
                    padding: '8px 12px',
                    cursor: 'pointer',
                    fontSize: '0.85rem',
                    borderBottom: '1px solid #f1f5f9',
                    lineHeight: '1.3',
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = '#f8fafc')}
                  onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
                >
                  <div style={{ fontWeight: 600, color: '#1e293b' }}>
                    📍 {item.display_name.split(',')[0]}
                  </div>
                  <div style={{ fontSize: '0.75rem', color: '#64748b', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {item.display_name}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* ตัวเลือกดู/แก้ไขพิกัดตัวเลข (Lat, Lon) */}
        <div>
          <button
            onClick={() => setShowManualCoords(!showManualCoords)}
            style={{
              background: 'none',
              border: 'none',
              color: '#64748b',
              fontSize: '0.78rem',
              cursor: 'pointer',
              padding: 0,
              textDecoration: 'underline',
            }}
          >
            {showManualCoords ? 'ซ่อนพิกัดตัวเลข (Lat, Lon)' : '⚙️ ดู / ปรับตัวเลขพิกัด Lat, Lon ด้วยตนเอง'}
          </button>

          {showManualCoords && (
            <div style={{ marginTop: '8px', padding: '10px', backgroundColor: '#f8fafc', borderRadius: '8px', fontSize: '0.82rem' }}>
              <div style={{ marginBottom: '6px' }}>
                <span style={{ fontWeight: 600, color: '#047857' }}>ต้นทาง:</span> {origin.lat.toFixed(5)}, {origin.lon.toFixed(5)}
                <div style={{ display: 'flex', gap: '6px', marginTop: '2px' }}>
                  <input
                    type="number"
                    step="any"
                    value={origin.lat}
                    onChange={(e) => setOrigin({ ...origin, lat: parseFloat(e.target.value) || 0 })}
                    style={{ width: '50%', padding: '4px', border: '1px solid #cbd5e1', borderRadius: '4px' }}
                  />
                  <input
                    type="number"
                    step="any"
                    value={origin.lon}
                    onChange={(e) => setOrigin({ ...origin, lon: parseFloat(e.target.value) || 0 })}
                    style={{ width: '50%', padding: '4px', border: '1px solid #cbd5e1', borderRadius: '4px' }}
                  />
                </div>
              </div>
              <div>
                <span style={{ fontWeight: 600, color: '#b91c1c' }}>ปลายทาง:</span> {destination.lat.toFixed(5)}, {destination.lon.toFixed(5)}
                <div style={{ display: 'flex', gap: '6px', marginTop: '2px' }}>
                  <input
                    type="number"
                    step="any"
                    value={destination.lat}
                    onChange={(e) => setDestination({ ...destination, lat: parseFloat(e.target.value) || 0 })}
                    style={{ width: '50%', padding: '4px', border: '1px solid #cbd5e1', borderRadius: '4px' }}
                  />
                  <input
                    type="number"
                    step="any"
                    value={destination.lon}
                    onChange={(e) => setDestination({ ...destination, lon: parseFloat(e.target.value) || 0 })}
                    style={{ width: '50%', padding: '4px', border: '1px solid #cbd5e1', borderRadius: '4px' }}
                  />
                </div>
              </div>
            </div>
          )}
        </div>

        {/* ปุ่มสแกนเส้นทาง */}
        <button
          onClick={handleCheckRain}
          disabled={loading}
          style={{
            padding: '14px',
            backgroundColor: loading ? '#93c5fd' : '#2563eb',
            color: 'white',
            border: 'none',
            borderRadius: '8px',
            cursor: loading ? 'not-allowed' : 'pointer',
            fontWeight: 700,
            fontSize: '1rem',
            boxShadow: '0 4px 12px rgba(37,99,235,0.25)',
            transition: 'all 0.15s ease',
          }}
        >
          {loading ? '⏳ กำลังคำนวณและสแกนเรดาร์ฝน...' : '⚡ สแกนเส้นทาง & เช็คฝน'}
        </button>

        {/* สรุปผลการวิเคราะห์ */}
        {data && (
          <div
            style={{
              padding: '16px',
              borderRadius: '8px',
              backgroundColor: '#f8fafc',
              borderLeft: `6px solid ${getStatusColor(data.summary.status)}`,
              boxShadow: '0 2px 6px rgba(0,0,0,0.04)',
            }}
          >
            <h3 style={{ margin: '0 0 10px 0', fontSize: '1.1rem', fontWeight: 700 }}>
              สถานะ: <span style={{ color: getStatusColor(data.summary.status) }}>{data.summary.status}</span>
            </h3>
            <p style={{ margin: '6px 0', fontSize: '0.92rem' }}>📏 ระยะทาง: <strong>{data.summary.totalDistanceKm}</strong> กม.</p>
            <p style={{ margin: '6px 0', fontSize: '0.92rem' }}>⏱️ เวลาเดินทาง: <strong>{data.summary.totalDurationMin}</strong> นาที</p>
            <p style={{ margin: '6px 0', fontSize: '0.92rem' }}>🌧️ โอกาสฝนตกสูงสุด: <strong>{data.summary.maxRainProbability}%</strong></p>
            <div
              style={{
                marginTop: '10px',
                padding: '10px',
                backgroundColor: '#ffffff',
                borderRadius: '6px',
                border: '1px solid #e2e8f0',
                fontSize: '0.88rem',
                color: '#334155',
                lineHeight: '1.45',
              }}
            >
              💡 <strong>คำแนะนำ:</strong> {data.summary.recommendation}
            </div>
          </div>
        )}
      </div>

      {/* พื้นที่แผนที่ Leaflet */}
      <div style={{ flex: 1, height: '100%', position: 'relative' }}>
        <MapContainer
          center={[origin.lat, origin.lon]}
          zoom={12}
          style={{ height: '100%', width: '100%' }}
        >
          <TileLayer
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          />

          <MapController
            origin={origin}
            destination={destination}
            routeCoords={polylinePositions}
          />

          {/* จุดเริ่มต้น (🟢 Origin Marker) */}
          <CircleMarker
            center={[origin.lat, origin.lon]}
            radius={10}
            pathOptions={{
              fillColor: '#10b981',
              fillOpacity: 1,
              color: '#ffffff',
              weight: 3,
            }}
          >
            <Popup>
              <div>
                <strong style={{ color: '#047857' }}>🟢 จุดเริ่มต้น</strong><br />
                {originName}<br />
                <small style={{ color: '#64748b' }}>({origin.lat.toFixed(4)}, {origin.lon.toFixed(4)})</small>
              </div>
            </Popup>
          </CircleMarker>

          {/* จุดปลายทาง (🔴 Destination Marker) */}
          <CircleMarker
            center={[destination.lat, destination.lon]}
            radius={10}
            pathOptions={{
              fillColor: '#ef4444',
              fillOpacity: 1,
              color: '#ffffff',
              weight: 3,
            }}
          >
            <Popup>
              <div>
                <strong style={{ color: '#b91c1c' }}>🔴 จุดหมายปลายทาง</strong><br />
                {destinationName}<br />
                <small style={{ color: '#64748b' }}>({destination.lat.toFixed(4)}, {destination.lon.toFixed(4)})</small>
              </div>
            </Popup>
          </CircleMarker>

          {/* เส้นทางการขับขี่ */}
          {polylinePositions.length > 0 && (
            <Polyline positions={polylinePositions} color="#2563eb" weight={6} opacity={0.8} />
          )}

          {/* จุดตรวจสอบสภาพอากาศ (Checkpoints) */}
          {data?.checkpoints.map((pt) => (
            <CircleMarker
              key={pt.id}
              center={[pt.lat, pt.lon]}
              radius={7}
              pathOptions={{
                fillColor: getStatusColor(pt.status),
                fillOpacity: 1,
                color: '#ffffff',
                weight: 2,
              }}
            >
              <Popup>
                <div>
                  <strong>จุดตรวจสอบที่ {pt.id}</strong><br />
                  โอกาสฝนตก: <strong>{pt.rainProbability}%</strong><br />
                  ปริมาณฝน: <strong>{pt.rainAmountMm} มม.</strong><br />
                  ระดับ: <span style={{ color: getStatusColor(pt.status), fontWeight: 'bold' }}>{pt.status}</span>
                </div>
              </Popup>
            </CircleMarker>
          ))}
        </MapContainer>
      </div>
    </div>
  );
}

export default App;