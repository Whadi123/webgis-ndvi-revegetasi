# RevegWatch NDVI

WebGIS statis untuk pemantauan revegetasi. Pengguna cukup mengunggah **ZIP shapefile poligon**, memilih periode, lalu aplikasi mencari citra Sentinel-2 L2A terbaik dan menghitung NDVI langsung di browser.

## Fitur

- Upload ZIP shapefile (`.shp`, `.shx`, `.dbf`, `.prj`).
- Pencarian Sentinel-2 L2A berdasarkan AOI, tanggal, dan tutupan awan.
- NDVI `(B08 - B04) / (B08 + B04)`.
- Masking hasil menggunakan batas poligon.
- Peta kelas NDVI, statistik minimum/rata-rata/maksimum, dan proporsi vegetasi.
- Unduh ringkasan hasil sebagai CSV.
- Siap di-host gratis melalui GitHub Pages.

## Publikasi ke GitHub Pages

1. Buat repository baru di GitHub, misalnya `revegwatch-ndvi`.
2. Unggah seluruh isi folder ini ke repository tersebut.
3. Buka **Settings → Pages**.
4. Pada **Build and deployment**, pilih **GitHub Actions**.
5. Workflow `Deploy static site to Pages` akan berjalan otomatis.
6. Alamat aplikasi akan berbentuk `https://USERNAME.github.io/revegwatch-ndvi/`.

Alternatif: pilih **Deploy from a branch**, lalu gunakan branch `main` dan folder `/root`.

## Format shapefile

Kompres semua komponen berikut dalam satu ZIP:

```text
area_revegetasi.shp
area_revegetasi.shx
area_revegetasi.dbf
area_revegetasi.prj
```

Geometri harus Polygon atau MultiPolygon. Sistem koordinat disarankan WGS 84 atau memiliki file `.prj` yang valid.

## Catatan teknis

Aplikasi menggunakan GitHub Pages sebagai hosting statis, Leaflet untuk peta, shpjs untuk membaca shapefile, Turf.js untuk operasi geometri, geotiff.js untuk membaca COG, dan Microsoft Planetary Computer STAC untuk arsip Sentinel-2 L2A.

Pemrosesan dilakukan pada grid 256–768 piksel agar tetap memungkinkan dijalankan di browser. Ini sesuai untuk pemantauan cepat dan visualisasi. Untuk pengolahan operasional berskala sangat luas, mosaik multi-scene, cloud masking SCL yang ketat, atau keluaran GeoTIFF resolusi penuh, gunakan backend geospasial/GEE.

## Lisensi

MIT License.
