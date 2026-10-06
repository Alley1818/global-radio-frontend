import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import Hls from "hls.js";
import Globe from "./Globe";
import { toGeoPoint } from "./geo";
import type { GeoPoint } from "./geo";

const API_URL = "http://127.0.0.1:8000";
const RADIO_BROWSER_URL = "https://de1.api.radio-browser.info/json/stations/search";

interface Station {
  stationuuid: string;
  name: string;
  url?: string;
  url_resolved?: string;
  stream_url?: string;
  country?: string;
  countrycode?: string;
  geo_lat?: number | null;
  geo_long?: number | null;
  tags?: string;
  bitrate?: number;
}

type SearchStatus = "idle" | "loading" | "success" | "error";

async function isHlsStream(url: string): Promise<boolean> {
  const controller = new AbortController();
  try {
    const res = await fetch(url, { signal: controller.signal });
    const type = (res.headers.get("content-type") ?? "").toLowerCase();
    return type.includes("mpegurl");
  } catch {
    return false;
  } finally {
    controller.abort();
  }
}

function looksLikeHls(url: string): boolean {
  return /\.m3u8?(\?|#|$)/i.test(url);
}

function getInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "♪";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

function getHue(text: string): number {
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    hash = text.charCodeAt(i) + ((hash << 5) - hash);
  }
  return Math.abs(hash) % 360;
}

function StationIcon({ name, id }: { name: string; id: string }) {
  const hue = getHue(id + name);
  return (
    <div
      className="station-icon"
      style={{
        background: `linear-gradient(135deg, hsl(${hue} 45% 32%), hsl(${(hue + 40) % 360} 55% 18%))`,
      }}
      aria-hidden="true"
    >
      {getInitials(name)}
    </div>
  );
}

function PlayIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true">
      <path d="M8 5v14l11-7z" />
    </svg>
  );
}

function PauseIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true">
      <path d="M6 5h4v14H6zM14 5h4v14h-4z" />
    </svg>
  );
}

function VolumeIcon({ muted }: { muted: boolean }) {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true">
      {muted ? (
        <path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51A8.796 8.796 0 0021 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z" />
      ) : (
        <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0 0 14 8v8a4.5 4.5 0 0 0 2.5-4zM14 3.2v2.1c2.9.9 5 3.5 5 6.7s-2.1 5.8-5 6.7v2.1c4-.9 7-4.5 7-8.8s-3-7.9-7-8.8z" />
      )}
    </svg>
  );
}

function PlayerTitle({ name, playing }: { name: string; playing: boolean }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [overflowing, setOverflowing] = useState<boolean>(false);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const check = () => {
      const span = el.querySelector("span");
      setOverflowing(span ? span.scrollWidth > el.clientWidth + 2 : false);
    };
    check();
    const observer = new ResizeObserver(check);
    observer.observe(el);
    return () => observer.disconnect();
  }, [name]);

  return (
    <div className="player-title-marquee" ref={containerRef}>
      {overflowing ? (
        <div className={`marquee-inner${playing ? " marquee-running" : ""}`}>
          <span>{name}</span>
          <span aria-hidden="true">{name}</span>
        </div>
      ) : (
        <span className="player-title-static" title={name}>
          {name}
        </span>
      )}
    </div>
  );
}

function Equalizer() {
  return (
    <span className="eq" aria-hidden="true">
      <i />
      <i />
      <i />
      <i />
    </span>
  );
}

export default function App() {
  const [query, setQuery] = useState<string>("BBC Radio");
  const [stations, setStations] = useState<Station[]>([]);
  const [status, setStatus] = useState<SearchStatus>("idle");
  const [searchError, setSearchError] = useState<string>("");
  const [useFallback, setUseFallback] = useState<boolean>(false);

  const [currentStation, setCurrentStation] = useState<Station | null>(null);
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [isBuffering, setIsBuffering] = useState<boolean>(false);
  const [playerError, setPlayerError] = useState<string>("");
  const [volume, setVolume] = useState<number>(0.8);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const searchAbortRef = useRef<AbortController | null>(null);
  const hlsRef = useRef<Hls | null>(null);
  const playIdRef = useRef<number>(0);
  const fallbackRef = useRef<boolean>(false);

  const globePoints = useMemo<GeoPoint[]>(
    () => stations.map(toGeoPoint).filter((p): p is GeoPoint => p !== null),
    [stations]
  );

  const setFallback = (value: boolean) => {
    fallbackRef.current = value;
    setUseFallback(value);
  };

  const destroyHls = () => {
    if (hlsRef.current) {
      hlsRef.current.destroy();
      hlsRef.current = null;
    }
  };

  const fetchFromRadioBrowser = useCallback(
    async (name: string, signal: AbortSignal): Promise<Station[]> => {
      const params = new URLSearchParams({
        name,
        limit: "30",
        order: "votes",
        reverse: "true",
        hidebroken: "true",
      });
      const response = await fetch(`${RADIO_BROWSER_URL}?${params.toString()}`, { signal });
      if (!response.ok) {
        throw new Error(`Ошибка Radio Browser: HTTP ${response.status}`);
      }
      const data: unknown = await response.json();
      if (!Array.isArray(data)) {
        throw new Error("Radio Browser вернул некорректный ответ");
      }
      return data as Station[];
    },
    []
  );

  const search = useCallback(
    async (name: string) => {
      const trimmed = name.trim();
      if (!trimmed) return;

      searchAbortRef.current?.abort();
      const controller = new AbortController();
      searchAbortRef.current = controller;

      setStatus("loading");
      setSearchError("");

      try {
        if (fallbackRef.current) {
          const data = await fetchFromRadioBrowser(trimmed, controller.signal);
          setStations(data);
          setStatus("success");
          return;
        }

        try {
          const response = await fetch(`${API_URL}/?name=${encodeURIComponent(trimmed)}`, {
            signal: controller.signal,
          });

          if (!response.ok) {
            throw new Error(`Ошибка сервера: HTTP ${response.status}`);
          }

          const data: unknown = await response.json();
          if (!Array.isArray(data)) {
            throw new Error("Сервер вернул некорректный ответ");
          }

          setStations(data as Station[]);
          setStatus("success");
        } catch (err) {
          if (err instanceof DOMException && err.name === "AbortError") return;
          // Backend недоступен (сетевая ошибка) — переключаемся на Radio Browser
          if (err instanceof TypeError) {
            const data = await fetchFromRadioBrowser(trimmed, controller.signal);
            setFallback(true);
            setStations(data);
            setStatus("success");
            return;
          }
          throw err;
        }
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;

        setStations([]);
        setStatus("error");
        if (err instanceof TypeError) {
          setSearchError(
            "Нет соединения: backend (127.0.0.1:8000) и Radio Browser недоступны. Проверьте сеть."
          );
        } else if (err instanceof Error) {
          setSearchError(err.message);
        } else {
          setSearchError("Неизвестная ошибка");
        }
      }
    },
    [fetchFromRadioBrowser]
  );

  useEffect(() => {
    void search("BBC Radio");
    return () => searchAbortRef.current?.abort();
  }, [search]);

  useEffect(() => {
    if (audioRef.current) {
      audioRef.current.volume = volume;
    }
  }, [volume]);

  useEffect(() => {
    const audio = audioRef.current;
    return () => {
      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }
      if (audio) {
        audio.pause();
        audio.removeAttribute("src");
        audio.load();
      }
    };
  }, []);

  const handleSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    void search(query);
  };

  const getStreamUrl = (station: Station): string => {
    if (fallbackRef.current) {
      return station.url_resolved || station.url || station.stream_url || "";
    }
    return `${API_URL}/stream?uuid=${encodeURIComponent(station.stationuuid)}`;
  };

  const togglePlay = async () => {
    const audio = audioRef.current;
    if (!audio || !currentStation) return;

    if (audio.paused) {
      setPlayerError("");
      try {
        if (!audio.getAttribute("src") && !hlsRef.current) {
          audio.src = getStreamUrl(currentStation);
        }
        await audio.play();
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setPlayerError("Не удалось запустить поток. Попробуйте другую станцию.");
      }
    } else {
      audio.pause();
    }
  };

  const playStation = async (station: Station) => {
    const audio = audioRef.current;
    if (!audio) return;

    if (currentStation?.stationuuid === station.stationuuid) {
      void togglePlay();
      return;
    }

    const playId = ++playIdRef.current;

    destroyHls();
    audio.pause();
    audio.removeAttribute("src");
    audio.load();

    setCurrentStation(station);
    setPlayerError("");
    setIsPlaying(false);
    setIsBuffering(true);
    audio.volume = volume;

    const url = getStreamUrl(station);
    if (!url) {
      setIsBuffering(false);
      setPlayerError("У станции нет доступного потока.");
      return;
    }

    const hlsStream = fallbackRef.current ? looksLikeHls(url) : await isHlsStream(url);
    if (playId !== playIdRef.current) return;

    if (hlsStream && Hls.isSupported()) {
      const hls = new Hls();
      hlsRef.current = hls;
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (data.fatal && playId === playIdRef.current) {
          setIsBuffering(false);
          setIsPlaying(false);
          setPlayerError("Ошибка воспроизведения потока. Станция недоступна.");
        }
      });
      hls.loadSource(url);
      hls.attachMedia(audio);
    } else {
      audio.src = url;
    }

    try {
      await audio.play();
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      if (playId !== playIdRef.current) return;
      setIsBuffering(false);
      setIsPlaying(false);
      setPlayerError("Не удалось запустить поток. Попробуйте другую станцию.");
    }
  };

  const handleAudioError = () => {
    const audio = audioRef.current;
    if (!audio || !audio.getAttribute("src")) return;
    setIsBuffering(false);
    setIsPlaying(false);
    setPlayerError("Ошибка воспроизведения потока. Станция недоступна или формат не поддерживается.");
  };

  const isActive = (station: Station) => currentStation?.stationuuid === station.stationuuid;

  return (
    <div className="app">
      <header className="header">
        <div className="header-grid" aria-hidden="true" />
        <div className="container header-content">
          <div className="brand">
            <span className={`onair-dot${isPlaying ? " onair-live" : ""}`} aria-hidden="true" />
            <div className="brand-text">
              <span className="overline">Мировое радиовещание · Live</span>
              <h1>Global Radio</h1>
            </div>
          </div>
          <p className="subtitle">
            Тысячи станций со всего мира — найдите свою волну и слушайте в один клик.
          </p>

          <form className="search" onSubmit={handleSubmit}>
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Название станции, например BBC Radio"
              aria-label="Поиск радиостанции"
            />
            <button type="submit" disabled={status === "loading" || !query.trim()}>
              Найти
            </button>
          </form>

          {useFallback && (
            <p className="fallback-note" role="status">
              Локальный backend недоступен — станции загружаются напрямую через Radio&nbsp;Browser.
            </p>
          )}
        </div>
      </header>

      <main className="container main">
        {status === "loading" && (
          <ul className="grid" aria-label="Загрузка станций">
            {Array.from({ length: 6 }, (_, i) => (
              <li className="card card-skeleton" key={i} aria-hidden="true">
                <div className="skeleton skeleton-icon" />
                <div className="card-info">
                  <div className="skeleton skeleton-line" />
                  <div className="skeleton skeleton-line skeleton-line-short" />
                </div>
              </li>
            ))}
          </ul>
        )}

        {status === "error" && (
          <div className="state state-error">
            <p>{searchError}</p>
            <button className="ghost-btn" onClick={() => void search(query)}>
              Повторить
            </button>
          </div>
        )}

        {status === "success" && stations.length === 0 && (
          <div className="state">
            <p className="state-big">Тишина в эфире</p>
            <p>По запросу «{query.trim()}» ничего не найдено. Попробуйте другое название.</p>
          </div>
        )}

        {status === "success" && stations.length > 0 && (
          <>
            <Globe
              points={globePoints}
              total={stations.length}
              activeId={currentStation?.stationuuid ?? null}
              playing={isPlaying}
              onSelect={(id) => {
                const station = stations.find((s) => s.stationuuid === id);
                if (station) void playStation(station);
              }}
            />
            <p className="results-count">
              <span className="mono">СТАНЦИЙ НАЙДЕНО — {stations.length}</span>
            </p>
            <ul className="grid reveal-stagger">
              {stations.map((station, index) => {
                const active = isActive(station);
                const playingNow = active && isPlaying;
                return (
                  <li
                    key={station.stationuuid}
                    className={`card${active ? " card-active" : ""}`}
                    style={{ "--i": index } as React.CSSProperties}
                  >
                    <span className="card-index mono" aria-hidden="true">
                      {String(index + 1).padStart(2, "0")}
                    </span>
                    <StationIcon name={station.name} id={station.stationuuid} />
                    <div className="card-info">
                      <h3 title={station.name}>{station.name || "Без названия"}</h3>
                      <span className="card-status mono">
                        {playingNow ? (
                          <>
                            В ЭФИРЕ <Equalizer />
                          </>
                        ) : active ? (
                          isBuffering ? (
                            "БУФЕРИЗАЦИЯ…"
                          ) : (
                            "ПАУЗА"
                          )
                        ) : (
                          [station.countrycode || station.country, station.bitrate ? `${station.bitrate}k` : ""]
                            .filter(Boolean)
                            .join(" · ") || "RADIO"
                        )}
                      </span>
                    </div>
                    <button
                      className="play-btn"
                      onClick={() => void playStation(station)}
                      aria-label={playingNow ? `Пауза: ${station.name}` : `Слушать: ${station.name}`}
                    >
                      {playingNow ? <PauseIcon /> : <PlayIcon />}
                    </button>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </main>

      <footer className={`player${currentStation ? " player-visible" : ""}`}>
        <div className="player-inner">
          <div className="player-station">
            {currentStation && (
              <>
                <StationIcon name={currentStation.name} id={currentStation.stationuuid} />
                <div className="player-text">
                  <PlayerTitle name={currentStation.name} playing={isPlaying} />
                  <span className={`player-status mono${playerError ? " player-error" : ""}`}>
                    {playerError ? (
                      playerError
                    ) : isBuffering ? (
                      "ПОДКЛЮЧЕНИЕ…"
                    ) : isPlaying ? (
                      <>
                        <span className="live-dot" aria-hidden="true" /> В ЭФИРЕ
                      </>
                    ) : (
                      "ПАУЗА"
                    )}
                  </span>
                </div>
              </>
            )}
          </div>

          <button
            className="player-toggle"
            onClick={() => void togglePlay()}
            disabled={!currentStation}
            aria-label={isPlaying ? "Пауза" : "Слушать"}
          >
            {isPlaying ? <PauseIcon /> : <PlayIcon />}
          </button>

          <div className="player-volume">
            <button
              className="icon-btn"
              onClick={() => setVolume((v) => (v === 0 ? 0.8 : 0))}
              aria-label={volume === 0 ? "Включить звук" : "Выключить звук"}
            >
              <VolumeIcon muted={volume === 0} />
            </button>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={volume}
              onChange={(e) => setVolume(Number(e.target.value))}
              aria-label="Громкость"
              style={{ "--vol": `${volume * 100}%` } as React.CSSProperties}
            />
            <span className="volume-value mono">{Math.round(volume * 100)}%</span>
          </div>
        </div>
      </footer>

      <audio
        ref={audioRef}
        preload="none"
        onPlay={() => setIsPlaying(true)}
        onPause={() => setIsPlaying(false)}
        onWaiting={() => setIsBuffering(true)}
        onPlaying={() => {
          setIsBuffering(false);
          setIsPlaying(true);
          setPlayerError("");
        }}
        onCanPlay={() => setIsBuffering(false)}
        onError={handleAudioError}
      />
    </div>
  );
}
