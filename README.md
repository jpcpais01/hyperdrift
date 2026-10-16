# Hyperdrift

Jogo de corridas arcade 3D, estilo Need for Speed, em pistas fantásticas suspensas no céu.
PWA instalável feita com Vite + TypeScript + Three.js (WebGL2), pronta para a Vercel.

## Jogar

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # gera dist/ (com service worker e manifest)
npm test         # pista, física e encaixe das partes
```

Controlos: **↑** acelerar, **↓** travar e depois marcha-atrás, **← →** virar.
Travar enquanto se curva a alta velocidade (ou manter a curva no máximo) inicia um **drift**;
ao sair do drift ganhas um boost proporcional ao tempo de drift. No telemóvel há botões de toque;
o comando de consola também funciona.

## O que há na demo

- **Menu** com uma corrida de IA ao vivo como fundo, **garagem**, **corrida** (3 voltas contra 3 IA),
  **contrarrelógio com fantasma** (a melhor volta fica guardada no dispositivo) e **resultados**.
- **Pista "Skyway Prime"** (~3,7 km): saltos, um loop, um túnel de luz em saca-rolhas, curvas inclinadas,
  zonas de boost e cristais de nitro.
- **Carros feitos só de partes**: um esqueleto comum invisível (`src/car/skeleton.ts`) com pontos de encaixe
  padronizados. As partes visuais (carroçaria, frente, traseira, capô, saias, spoiler, jantes, faróis, escape,
  pintura e vinil) são geometria procedural que encaixa nesses pontos; faróis, escapes, capô e spoiler
  "procuram" a superfície da peça vizinha, por isso qualquer combinação encaixa.
- **Partes técnicas** (motor, turbo, nitro, pneus, suspensão, peso) mudam as stats e a condução
  (`src/car/stats.ts`). As IA também são montadas a partir de partes.

## Escolhas técnicas

- Pista gerada por "tartaruga" (`src/track/`) com amostras por metro e referencial completo; a física
  corre em espaço-de-pista (sem raycasts), o que torna loops e saca-rolhas triviais e baratos.
- Iluminação pré-calculada: AO e luz emitida (carris, anéis do túnel, placas de boost, emissores
  anti-gravidade) estão cozinhadas nos vértices; ilhas com sol cozinhado; sombras dos carros em "blob".
- Reflexos por environment map (céu pré-filtrado com PMREM uma vez), bloom leve a meia resolução,
  motion blur radial barato, resolução dinâmica para manter o FPS.
- Instancing (ilhas com 2 LODs trocados por distância, cristais, anéis, rodas), pista em blocos para
  frustum culling, materiais partilhados entre carros.
- Som 100% sintetizado em WebAudio (motor por RPM, turbo, boost, derrapagem, vento).
- As texturas são geradas em canvas no arranque (poucos KB), por isso ainda não há ficheiros KTX2;
  quando entrar arte feita à mão, o caminho é `KTX2Loader` + `basisu`.

## Deploy

A Vercel deteta o Vite automaticamente (`vercel.json` incluído). O manifest usa `display: standalone`
sem orientação forçada; no primeiro toque o jogo pede ecrã inteiro e tenta bloquear em horizontal.
