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
  // Base path for panorama images and map assets (served statically).
  PANO_BASE_URL: '/panoramas',
  MAP_IMAGE_URL: '/map/map.png',
  // File extension of the panorama faces. Set to 'webp' (or 'jpg') after running
  // tools/compress-panoramas.js with that format; leave 'png' for raw captures.
  PANO_FACE_EXT: 'webp',
  // Street-View movement arrows. When true, the client fetches /links.json and
  // shows arrows to neighbouring panoramas you can roam to (scoring always stays
  // pinned to where the round STARTED, so roaming can't change your guess target).
  ENABLE_MOVEMENT: true,
  // Rotate all movement arrows by this many degrees if they don't line up with
  // the world (e.g. if the cubemap face order is rotated). No re-export needed.
  PANO_YAW_OFFSET: 180,

  // --- Live server map (Dynmap) ------------------------------------------
  // When enabled, the guessing map is the LIVE CCNet Dynmap instead of the
  // static map.png. This only makes sense if the panoramas were captured on
  // the same world (X/Z line up 1:1 with the nationsmap). Leave disabled to
  // use the bundled map.png. See map.ccnetmc.com/nationsmap.
  DYNMAP: {
    enabled: true,
    // Tile root (LiveAtlas/Dynmap): {baseUrl}/{world}/{prefix}/{folder}/{name}
    baseUrl: 'https://map.ccnetmc.com/nationsmap/tiles',
    world: 'world',
    prefix: 'flat',
    ext: 'webp',
    tileSize: 128,          // Dynmap HD tile edge in pixels
    scale: 4,               // worldtomap: mapX = scale*worldX, mapY = -scale*worldZ
    nativeZoom: 6,          // Dynmap zoom-out 0 == this Leaflet zoom (tiles 1:1)
    minZoom: 0,             // Leaflet zoom range that has rendered tiles (n = native - zoom)
    maxZoom: 4,
    // Initial camera, from a share URL like #world;flat;16,64,8;0  -> x=16,z=8
    center: { x: 16, z: 8 },
    initialZoom: 3,
  },
};

