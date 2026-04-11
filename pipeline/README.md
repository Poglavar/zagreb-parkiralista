# Pipeline

Python skripte za obradu podataka. Svaka faza je samostalna i ima brojčani prefiks
po redoslijedu izvođenja.

## Setup

Phase 0 (OSM baseline) traži samo lake dependencies; ML faze trebaju težak install
sa torch + transformers + segment-geospatial.

```sh
cd pipeline
python3 -m venv .venv
source .venv/bin/activate
pip install --upgrade pip

# Phase 0 only — light deps
pip install -r requirements.txt

# Phase 1+ — heavy ML deps (~3 GB total: torch, transformers, samgeo, models)
pip install -r requirements-ml.txt
```

## Phase 0 — OSM baseline

```sh
python 00_fetch_osm.py
```

Skida sve `amenity=parking` ways i relations za Zagreb iz Overpass API-ja, računa
površine u EPSG:3765, procjenjuje kapacitet po formuli `area / 25 m²` za sve bez
`capacity` taga, i sprema u `data/osm/parking_zagreb.geojson`.

Trenutno: ~4,800 features, ~3.91 km² parking površine, ~7% s OSM capacity tagom.

Opcije:
- `--bbox south,west,north,east` — drugi bbox umjesto Zagreba
- `--m2-per-stall 25.0` — drugačiji koeficijent za area-based estimate
- `--out path` — drugi output path

## Phase 1 — ML pronalazak nedostajućih parkirališta

### Step 1: Skinuti orthophoto tile-ove

```sh
# default: mali test bbox u centru Zagreba (~1 km²)
python 01_fetch_tiles.py

# Veći bbox + odabir izvora
python 01_fetch_tiles.py --bbox 15.95,45.79,15.99,45.82 --source cdof2022

# Test prvih 5 tile-ova bez ostatka
python 01_fetch_tiles.py --max-tiles 5
```

Izvori:
- `cdof2022` (default) — Grad Zagreb CDOF 2022, ~0.15 m/px, layer `ZG_CDOF2022`
- `dof5` — DGU DOF5 2023/24, 0.5 m/px, nacionalna pokrivenost

Output: `data/tiles/<source>/tile_<col>_<row>.tif`. Tile-ovi su poravnati na
globalnu mrežu u EPSG:3765 tako da se mogu reciklirati kroz preklapajuće runs.

### Step 1b: Alternativni izvor — TMS tile-ovi (Zagreb 2018 ortofoto)

```sh
# Mali test (4 output tile-a)
python 01b_fetch_tms.py --bbox 15.975,45.812,15.980,45.815 --zoom 20 --max-tiles 4

# Centralni Zagreb (~2350 tile-ova, ~95 min, ~1 GB na disku)
python 01b_fetch_tms.py --bbox 15.94,45.79,16.02,45.83 --zoom 20

# Zoom 19 za brži download (manji GSD ali manje tile-ova)
python 01b_fetch_tms.py --bbox 15.94,45.79,16.02,45.83 --zoom 19
```

Alternativni tile fetcher koji skida s TMS endpoint-a (community orthophoto
`https://tms.osm-hr.org/zagreb-2018/{z}/{x}/{y}.png`), stitcha 4×4 TMS tile-ova
(256×256 px svaki) u jednu 1024×1024 sliku, i reprojektira u EPSG:3765 GeoTIFF
— kompatibilno s ostatkom pipeline-a bez ikakvih izmjena downstream skripti.

| Zoom | GSD | Veličina auta | Output tile | Vrijeme za centar ZG |
|---|---|---|---|---|
| 18 | 0,42 m/px | 10×5 px | ~107 m, ~600 tile-ova | ~15 min |
| 19 | 0,21 m/px | 19×10 px | ~53 m, ~600 tile-ova | ~25 min |
| 20 | 0,10 m/px | 38×19 px | ~107 m, ~2350 tile-ova | ~95 min |

Output: `data/tiles/<source-name>/tile_<col>_<row>.tif` — isti format kao
`01_fetch_tiles.py`, pa `11_detect_vehicles.py` i `30_render_composite.py`
rade bez promjena.

**Napomena**: TMS server je community-run volonterski servis (osm-hr.org).
Default throttle je 150 ms — nemoj ga preopteretiti.

### Step 2: SAM 3 segmentacija (čeka HF gating)

```sh
python 02_segment.py --tiles ../data/tiles/cdof2022 --prompt "parking lot"
python 02_segment.py --tiles ../data/tiles/cdof2022 --backend langsam   # fallback (trenutno slomljen)
```

Učitava `samgeo.SamGeo3` s `backend="transformers"` (HuggingFace transformers
implementation), koja radi na Apple Silicon kroz MPS. Default `backend="meta"`
ima tvrdu ovisnost o NVIDIA Triton/CUDA i ne radi na Mac-u.

Za svaki tile postavlja sliku i poziva `generate_masks(prompt="parking lot")`,
zatim sprema masku kao GeoTIFF s očuvanim georeferenciranjem.

**HuggingFace gated repo**: `facebook/sam3` zahtijeva access. Workflow:
1. Posjeti https://huggingface.co/facebook/sam3 i klikni "Agree and access"
2. Pričekaj manualni review od Meta-e (sati do dana)
3. Generiraj read token: https://huggingface.co/settings/tokens
4. Spremi u root `.env` kao `HF_API_KEY=hf_xxx` — script ga premosti u `HF_TOKEN`

Opcije:
- `--prompt "parking lot"` — text prompt (default)
- `--backend sam3` (default) ili `--backend langsam` (GroundingDINO + SAM 1, ne-gated, ali trenutno slomljen zbog `transformers 5.5` ↔ `groundingdino-py 0.4.0` inkompatibilnosti)
- `--conf-threshold 0.5 --mask-threshold 0.5` — strogi pragovi za SAM 3
- `--limit 5` — smoke test na prvih 5 tile-ova

**Mac napomena**: prvo pokretanje će skinuti SAM 3 weight-ove (~3 GB). MPS backend
će se koristiti automatski na Apple Silicon, ali sporiji je od CUDA-e.

### Step 3: Maska → poligoni

```sh
python 03_vectorize.py --masks ../data/masks/cdof2022
```

Konvertira mask GeoTIFF-ove u kandidat poligone, primjenjuje filtere
(min površina, kompaktnost), opcionalno regularizira rubove.

Output: `data/candidates/raw_candidates.geojson`

### Step 4: Set-difference vs OSM baseline

```sh
python 04_diff_osm.py
```

Uspoređuje kandidate s OSM baseline-om iz Phase 0 koristeći IoU prag (default
0.3). Generira dva fila:

- `data/candidates/missing_parking.geojson` — kandidati koji NE preklapaju OSM
  (potencijalne dopune)
- `data/candidates/overlapping_parking.geojson` — kandidati koji preklapaju OSM
  (potvrda recall-a + lov na loše OSM poligone)

## Phase 2 — capacity refinement

```sh
python 10_refine_capacity.py
```

Spaja OSM baseline s Faza 1 ML kandidatima u jedan finalni GeoJSON s
`capacity_final` i `capacity_method` poljem. Trenutno koristi area-based
heuristiku; v2 će koristiti detekciju mjesta iz Faze 3.

Output: `data/final/parking_with_capacity.geojson`

## Phase 3 — neslužbena ("de facto") parkirališta

### Step 1: detekcija vozila iz zraka

```sh
python 11_detect_vehicles.py --tiles ../data/tiles/cdof2022
python 11_detect_vehicles.py --tiles ../data/tiles/cdof2022 --conf 0.05 --require-plausible-size
```

Pokreće Ultralytics YOLO nad tile dirom, ekstrahira detekcije vozila
(automobili, kamioni, motori, busevi) i sprema kao Point GeoJSON s
georeferenciranim koordinatama. Default model `yolov8n.pt` je COCO trained
i daje samo grube rezultate na aerial — koristi `--require-plausible-size`
da se izbace bizarno velike/male detekcije.

Output: `data/candidates/vehicles.geojson`

### Step 1.5: pretvoriti tile-ove u JPEG za viewer popup

```sh
python 12_export_tile_jpegs.py
python 12_export_tile_jpegs.py --max-size 512   # downscale za manje datoteke
```

Konvertira sve `.tif` GeoTIFF tile-ove iz `../data/tiles/cdof2022/` u JPEG-ove
u `../data/tiles_jpg/cdof2022/`. JPEG-ovi nemaju georeferenciranje, ali zadrže
isti pixel grid (1024×1024) — tako viewer može pokazati 256×256 isječak oko
detektiranog auta. Kompresija je tipično ~28× (4 MB TIFF → ~150 KB JPEG).

Resumable (skipa postojeće `.jpg` fajlove).

Output: `data/tiles_jpg/cdof2022/tile_<col>_<row>.jpg`

### Step 2: dohvatiti OSM landuse za klasifikaciju

```sh
python 21_fetch_landuse.py
```

Skida sve `landuse=*`, `leisure=*`, `natural=*`, `amenity=*` poligone iz
Overpass-a za Zagreb i klasificira ih u kategorije (park, school_grounds,
residential_block, industrial_yard, square itd.). Veliki download (~27 MB).

Output: `data/osm/landuse_zagreb.geojson`

### Step 3: detekcija neslužbenog parkiranja

```sh
python 20_detect_informal.py
```

Provjerava svako detektirano vozilo protiv unije svih službenih parkirnih
poligona (OSM + opcionalno ML kandidati iz Faze 1) bufferiranih za 5 m.
Vozila izvan svih službenih parkirnih → neslužbena. Svako neslužbeno vozilo
zatim klasificira kroz landuse intersection (residential_block / park /
school_grounds / itd.).

Output: `data/final/informal_parking.geojson`

## Phase 5 — LLM cartographer

Vision LLM kao "kartograf koji čita karte". Pipeline pakira aerial + OSM road
overlay + postojeće parking poligone + YOLO vehicle detekcije u jednu composite
PNG sliku, šalje je vision API-ju (Claude ili GPT), parsira strukturirane JSON
prijedloge, i georeferencira ih natrag u WGS84. Vidi memory
`composite_overlay_llm_pattern.md` za arhitektonski pattern.

### Step 1: dohvatiti OSM highway network

```sh
python 22_fetch_highways.py
```

Skida sve `highway=*` features iz Overpass-a za Zagreb (~90.000 way-ova,
~40 MB). Linije se kasnije iscrtavaju kao žute/bijele linije nad aerial-om
da se ulice vide čak i ispod krošnji.

Output: `data/osm/highways_zagreb.geojson`

### Step 2: render composite

```sh
# Default --grid 3 (3×3 = 460 m × 460 m); primjeri u repo-u koriste --grid 4
python 30_render_composite.py --center-tile 2980,33035 --grid 4

# Ili po WGS84 bbox-u
python 30_render_composite.py --bbox 15.96,45.80,15.98,45.82

# Ili po EPSG:3765 bbox-u
python 30_render_composite.py --bbox-3765 458000,5073000,458600,5073600
```

Spaja N×N CDOF tile-ova kroz `rasterio.merge` u jednu kvadratnu sliku
(default output 1024×1024 px). Crta na nju OSM ceste, postojeće parking
poligone (plavo s navy borderom), enclosed garage nodove (purple "P" pin),
YOLO vozila (mali crveni dotovi), i legendu u kutu.

Outputs:
- `data/composites/cdof2022/composite_<id>.png` — slika za LLM
- `data/composites/cdof2022/composite_<id>.json` — sidecar metadata s `bbox_3765`,
  `bbox_wgs84`, image dimenzijama, mpp, i listom source tile-ova. Treba ga
  step 3 da invertira `bbox_pct` natrag u WGS84.

Opcije:
- `--grid 3` ili `--grid 4` — N×N tile prozor
- `--output-size 1024` — pixel dimenzije izlazne slike
- `--no-vehicles` — ne crtaj YOLO dotove (cleaner image, manje konteksta za LLM)

### Step 3: LLM proposal

```sh
# Default: Claude Sonnet 4.6 (treba ANTHROPIC_API_KEY u .env)
python 31_llm_propose.py ../data/composites/cdof2022/composite_tile_2980_33035_g4.png

# OpenAI GPT-4o (treba OPENAI_API_KEY u .env)
python 31_llm_propose.py ../data/composites/cdof2022/composite_tile_2980_33035_g4.png --provider openai

# OpenAI GPT-5 — treba povećani token budget zbog hidden reasoning
python 31_llm_propose.py ../data/composites/cdof2022/composite_tile_2980_33035_g4.png --provider openai --model gpt-5 --max-tokens 10000

# A/B test oba providera (oba ključa moraju biti u .env)
python 31_llm_propose.py composite.png --provider both

# Batch nad svim composite-ima u dir-u
python 31_llm_propose.py --all --provider anthropic

# Dry run (no API call) — za QA prompt-a + image kvalitete
python 31_llm_propose.py composite.png --dry-run
```

Šalje composite + structured prompt vision API-ju, parsira JSON odgovor
(`{summary, suggestions: [{kind, confidence, reason, bbox_pct}]}`), za svaki
prijedlog mapira `bbox_pct` × image dimenzije × composite metadata bounds →
WGS84 polygon, i sprema kao GeoJSON.

Output: `data/candidates/llm_parking_candidates.geojson` — Polygon features s
`provider`, `model`, `kind`, `confidence`, `reason`, `source_composite`
propertima. Default ponašanje je **append + replace-by-id**, pa multi-provider
i multi-composite runs akumuliraju u jednu datoteku. `--overwrite` baca
postojeće.

**Defaultni token budget-i**:
- `anthropic`: 2000 tokens (sasvim dovoljno za Claude — output je ~600 tokens)
- `openai`: 6000 tokens (gpt-4o), `--max-tokens 10000` za gpt-5

**Stvarni rezultati** iz dosadašnjih runova (vidi top-level README ključni
nalaz #8 + memory `llm_vision_choice_april_2026.md`):
- Claude na 17 composites: 96 prijedloga (5,65 prosjek, ~$0,29 ukupno, ~12 s/poziv)
- GPT-5 na 4 composites: 4 prijedloga (1,0 prosjek, ~$0,17 ukupno, ~67 s/poziv)
- Claude je default izbor; GPT je vrijedan jedino kao high-precision second-opinion filter

## Tipičan workflow za Faze 2 + 3

```sh
source .venv/bin/activate

# 1. Skini orthophoto tile-ove (samo prvi put ili nakon širenja bbox-a)
python 01_fetch_tiles.py --bbox 15.94,45.79,16.02,45.83

# 2. (Jednom) skini OSM landuse za klasifikaciju
python 21_fetch_landuse.py

# 3. Detektiraj vozila
python 11_detect_vehicles.py --tiles ../data/tiles/cdof2022 --require-plausible-size

# 4. Klasificiraj neslužbena
python 20_detect_informal.py

# 5. Spoji sve u finalni capacity layer
python 10_refine_capacity.py

# 6. Otvori viewer
cd .. && python3 -m http.server 8000
```

## Tipičan workflow za Phase 1

```sh
# 1. Učitati venv
source .venv/bin/activate

# 2. Smoke test na 5 tile-ova prvo
python 01_fetch_tiles.py --max-tiles 5
python 02_segment.py --tiles ../data/tiles/cdof2022 --limit 5
python 03_vectorize.py --masks ../data/masks/cdof2022
python 04_diff_osm.py

# 3. Otvoriti viewer i vizualno provjeriti kandidate
cd .. && python3 -m http.server 8000

# 4. Ako rezultati izgledaju dobro, skalirati na veći bbox
python 01_fetch_tiles.py --bbox 15.92,45.78,16.02,45.83
# (i ponoviti 02-04)
```

## Troubleshooting

**`samgeo.SamGeo3` import fails** → trebaš ekstra dep: `pip install "segment-geospatial[samgeo3]"`

**SAM 3 init fails s 401 Unauthorized** → HF token nije postavljen. Spremi `HF_API_KEY=hf_xxx` u root `.env` (script ga čita automatski)

**SAM 3 init fails s 403 Forbidden / "awaiting review"** → traži access na https://huggingface.co/facebook/sam3, čekaj manualni review

**`SAM3_META_AVAILABLE: False` warning na Mac-u** → očekivano. `backend="meta"` traži NVIDIA Triton/CUDA. Mora se koristiti `backend="transformers"` (default u našem `02_segment.py`)

**LangSAM crash: `'BertModel' object has no attribute 'get_head_mask'`** → poznata inkompatibilnost između `transformers >= 5.0` (potrebno za SAM 3) i `groundingdino-py 0.4.0` (koristi staru BertModel API). Workaround: čekati SAM 3 access ili napraviti zasebni venv pinned na `transformers<5.0`

**WMS GetCapabilities timeout** → Grad Zagreb endpoint zna biti spor; pokušati ponovno ili koristiti `--source dof5` kao fallback

**Tile-ovi prazni / svi crni** → provjeri da je layer name točan u `SOURCES` u `01_fetch_tiles.py` (CDOF: `ZG_CDOF2022`, DOF5: provjeriti GetCapabilities za točnu vrijednost)

**YOLO daje smiješno puno false positive detekcija** → COCO YOLO nije treniran za top-down imagery. Koristi `--require-plausible-size` da se izbace detekcije neeralističnih dimenzija (default conf je 0.05; podigni na 0.15 za stricter precision). Za produkciju, fine-tunirati na CARPK datasetu.

**`20_detect_informal.py` daje 100% `roadside_or_unknown`** → stara verzija je imala variable name collision (`parts` overwritten između landuse i official parking trees). Fixed u trenutnoj verziji — ako se vrati, provjeri jesu li official_parts i parts (landuse) razdvojeni.

**`31_llm_propose.py` s GPT-5 vraća 0 prijedloga + completion_tokens=2000** → GPT-5 je potrošio cijeli budget na hidden reasoning prije nego što je počeo emit-ati JSON. Diže `--max-tokens` na 10000+. (gpt-4o nema hidden reasoning pa default 6000 funkcionira.)

**`31_llm_propose.py` "Empty content from OpenAI"** → isti problem kao gore, samo s eksplicitnijom porukom (script verzije ≥ 2026-04-09 prepoznaju empty response i daju jasniji error).

**Composite renderer pokazuje `Sequences of multi-polygons are not valid arguments`** → poznata Shapely 2.x kvarica u `relation_to_geometry` kad `buffer(0)` vrati MultiPolygon nad već unioned geometrijom. Fixed u trenutnoj verziji `21_fetch_landuse.py` i `00_fetch_osm.py` flatten-anjem nested multipolys prije konstrukcije parent MultiPolygon-a — provjeri da je ta logika prisutna ako se opet pojavi.

**LLM prijedlozi su "off the map"** → `bbox_pct` koordinata izvan [0, 1] ili composite metadata sidecar (`composite_*.json`) ima krivi `bbox_3765`. Provjeri da je `30_render_composite.py` zapisao sidecar JSON s istim coordinatima koje koristi `31_llm_propose.py:bbox_pct_to_polygon`.
