# 静かなる深海のクジラ

Binance の BTC/USDT を、深海としてリアルタイムに描く。

**https://amanesf.github.io/kujirabtc/**

縦軸は価格である。板に置かれた指値は深部の巨体になり、その質量は明るさではなく
**近さと暗さ**として現れる。すべての約定は本物の流体を押し、その航跡は約定より
何秒も長く生き残る。そして光はほぼすべて、**歪められた水**から来る——渦鞭毛藻が
そうであるように。

設計と判断の記録は [`plan.md`](plan.md) にある。残件も同じ場所。

## 動かす

```sh
cd app && npm ci
npm run dev
```

Binance の匿名 WebSocket（`aggTrade` と `depth20@100ms`）に直接つなぐ。鍵は要らない。
接続できない環境では8秒で合成潮流に切り替わる——同じ Pareto の裾を引くテープで、
本物より穏やかにも綺麗にもしていない。

## 測る

```sh
cd app && npm run build
node scripts/capture.js --shots 4 --every 8   # 実機サイズの静止画
node scripts/interact.js                       # 操作の前・直後・沈静後
```

書いている最中には見えず撮って初めて分かった不具合の一覧は `plan.md` §10 にある。
符号・単位・不可視要素の副作用は、ソースを読んでも見つからない。
