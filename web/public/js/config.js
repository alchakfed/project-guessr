/**
 * config.js — front-end configuration (edit to point at your server).
 *
 * Leave WS_URL empty to auto-connect to the same host/port that served the page
 * (works out of the box for localhost and LAN). Set it explicitly only if you
 * host the panoramas/map elsewhere.
 */
window.PG_CONFIG = {
  // e.g. 'ws://192.168.1.50:3000' — empty string = same origin as this page.
  WS_URL: '',
  // Base path for panorama images.
  // LOCAL: '/panoramas' (served by this server)
  // B2: 'https://f003.backblazeb2.com/file/ccguessr-db/panoramas' (set B2_DOWNLOAD_URL in Render env)
  PANO_BASE_URL: 'https://f003.backblazeb2.com/file/ccguessr-db/panoramas',
  MAP_IMAGE_URL: '/map/map.png',
  // File extension of the panorama faces. Set to 'webp' (or 'jpg') after running
  // tools/compress-panoramas.js with that format; leave 'png' for raw captures.
  PANO_FACE_EXT: 'webp',
  // Street-View movement arrows. When true, the client fetches /links.json and
  // shows arrows to neighbouring panoramas you can roam to (scoring always stays
  // pinned to where the round STARTED, so roaming can't change your guess target).
  ENABLE_MOVEMENT: true,
  // Rotate all movement arrows by this many degrees if they don't line up with
  // the world. With per-panorama capture headings baked into links.json's
  // arrowYaw (see build-links.js), this should be 0; use it only for a global
  // cubemap face-order rotation. No re-export needed.
  PANO_YAW_OFFSET: 0,
  // Handedness of the panorama vs. the world. +1 is normal; use -1 to un-mirror
  // when forward/back are correct but LEFT/RIGHT are swapped (a mirror can only
  // be fixed by flipping this sign, never by changing PANO_YAW_OFFSET).
  PANO_YAW_SIGN: 1,

  // --- Live server map (Dynmap) ------------------------------------------
  // When enabled, the guessing map is the LIVE CCNet Dynmap instead of the
  // static map.png. This only makes sense if the panoramas were captured on
  // the same world (X/Z line up 1:1 with the nationsmap). Leave disabled to
  // use the bundled map.png. See map.ccnetmc.com/nationsmap.
  DYNMAP: {
    enabled: true,
    // Tile root. By default we go through our OWN server's caching proxy
    // (/dyntiles/...) instead of hotlinking the third-party Dynmap directly:
    // that dedups + caches tiles so we don't flood map.ccnetmc.com (which gets
    // us rate-limited into black tiles). Set to the absolute upstream only if
    // you deliberately want to bypass the proxy. The proxy's upstream is set
    // server-side via DYNMAP_UPSTREAM (defaults to the CCNet nationsmap).
    baseUrl: '/dyntiles',
    world: 'world',
    prefix: 'flat',
    ext: 'webp',
    tileSize: 128,          // Dynmap HD tile edge in pixels
    scale: 4,               // worldtomap: mapX = scale*worldX, mapY = -scale*worldZ
    nativeZoom: 6,          // Dynmap zoom-out 0 == this Leaflet zoom (tiles 1:1)
    minZoom: 0,             // Leaflet zoom range that has rendered tiles (n = native - zoom)
    // maxNativeZoom = the deepest zoom the CCNet server actually renders tiles for
    // (n = nativeZoom - zoom = 0 -> the full-res, unprefixed tiles = CCNet's max
    // detail). maxZoom can go PAST that: Leaflet upscales those native tiles, so
    // you get an even finer grid for precise pin placement (slightly soft, but the
    // click still resolves to exact world coords). Keep maxNativeZoom == nativeZoom;
    // raise maxZoom for more over-zoom, lower it if upscaling looks too blurry.
    maxNativeZoom: 6,
    maxZoom: 7,
    // Initial camera, from a share URL like #world;flat;16,64,8;0  -> x=16,z=8
    center: { x: 16, z: 8 },
    // Start fully zoomed OUT (== minZoom) so players see the whole world first.
    initialZoom: 0,
    // Fine registration nudge (world blocks) applied ONLY to where markers are
    // drawn on the tiles — the truth pin, guess pin and result markers. Scoring
    // is pure world-space and is NOT affected, so this can never change who wins;
    // it only lines the pins up with the terrain underneath. Leave 0 if the pins
    // already sit on the right spot. If the "actual location" lands ~one tile too
    // far north/south, set markerOffsetZ to ±32 (one HD tile = tileSize/scale
    // blocks); flip the sign if it moves the wrong way.
    markerOffsetX: 0,
    markerOffsetZ: 32,
  },
};

