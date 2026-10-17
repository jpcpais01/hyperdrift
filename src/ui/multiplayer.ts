import { optionsFor, paintById } from '../car/parts';
import { audio } from '../core/audio';
import { CODE_LENGTH, MAX_PLAYERS } from '../net/protocol';
import type { Room } from '../net/room';

type View = 'home' | 'join' | 'lobby';

function esc(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

function paintCss(paint: string) {
  return '#' + paintById(paint).color.toString(16).padStart(6, '0');
}

function bodyName(id: string) {
  return optionsFor('body').find((o) => o.id === id)?.name ?? '';
}

const PAD = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'del', '0', 'ok'];

/**
 * Online play: pick a call sign, open a room or punch in a friend's 4-digit
 * code on a built-in number pad (no phone keyboard popping up over the game),
 * then wait in the lobby with your car until the host starts.
 */
export class MultiplayerScreen {
  readonly el: HTMLElement;
  private view: View = 'home';
  private digits = '';
  private busy = false;
  private room: Room | null = null;
  private codeEl: HTMLElement;
  private errEl: HTMLElement;
  private lobbyEl: HTMLElement;
  private nameEl: HTMLElement;
  private visible = false;

  onBack: (() => void) | null = null;
  onCreate: (() => void) | null = null;
  onJoin: ((code: string) => void) | null = null;
  onReroll: (() => void) | null = null;
  onStart: (() => void) | null = null;
  onBots: ((v: boolean) => void) | null = null;
  onGarage: (() => void) | null = null;
  onLeave: (() => void) | null = null;
  onResume: (() => void) | null = null;
  /** host: open the drift zone for the whole room */
  onZone: (() => void) | null = null;
  /** drop into the room's open drift zone */
  onEnterZone: (() => void) | null = null;
  /** what of mine is still running behind the lobby */
  private live: 'race' | 'zone' | null = null;

  constructor(root: HTMLElement, name: string) {
    this.el = document.createElement('div');
    this.el.className = 'screen mp hidden';
    this.el.innerHTML = `
      <div class="mp-home mp-view">
        <h2 class="mp-title">Multijogador</h2>
        <p class="mp-sub">Até ${MAX_PLAYERS} pilotos na mesma pista. Partilha o código da sala com os teus amigos.</p>
        <div class="mp-callsign">
          <small>O TEU NOME DE PILOTO</small>
          <div class="mp-cs-row"><b class="mp-name"></b><button class="mp-dice" data-a="reroll" aria-label="Outro nome">
            <svg viewBox="0 0 24 24"><rect x="3.5" y="3.5" width="17" height="17" rx="4"/><circle cx="8.5" cy="8.5" r="1.4"/><circle cx="15.5" cy="15.5" r="1.4"/><circle cx="15.5" cy="8.5" r="1.4"/><circle cx="8.5" cy="15.5" r="1.4"/><circle cx="12" cy="12" r="1.4"/></svg>
          </button></div>
        </div>
        <div class="mp-choices">
          <button class="mp-choice" data-a="create"><span class="mp-ico mp-ico-host"></span><b>Criar sala</b><small>Recebe um código e convida amigos</small></button>
          <button class="mp-choice" data-a="join"><span class="mp-ico mp-ico-join"></span><b>Entrar com código</b><small>Escreve os ${CODE_LENGTH} números da sala</small></button>
        </div>
        <p class="mp-notice"></p>
        <button class="btn small mp-back" data-a="back" data-back>‹ Menu</button>
      </div>
      <div class="mp-join mp-view">
        <h2 class="mp-title">Código da sala</h2>
        <div class="mp-code" aria-live="polite">${'<span></span>'.repeat(CODE_LENGTH)}</div>
        <p class="mp-err"></p>
        <div class="mp-pad">${PAD.map((k) =>
          k === 'del'
            ? '<button data-k="del" aria-label="Apagar"><svg viewBox="0 0 24 24"><path d="M9 5h11v14H9l-6-7z"/><path d="m12 9 5 6m0-6-5 6"/></svg></button>'
            : k === 'ok'
              ? '<button data-k="ok" class="ok" aria-label="Entrar"><svg viewBox="0 0 24 24"><path d="m5 12 5 5 9-10"/></svg></button>'
              : `<button data-k="${k}">${k}</button>`,
        ).join('')}</div>
        <button class="btn small mp-back" data-a="home" data-back>‹ Voltar</button>
      </div>
      <div class="mp-lobby mp-view"></div>
      <div class="mp-busy"><div class="mp-spin"></div><p></p></div>`;
    root.appendChild(this.el);
    this.codeEl = this.el.querySelector('.mp-code')!;
    this.errEl = this.el.querySelector('.mp-err')!;
    this.lobbyEl = this.el.querySelector('.mp-lobby')!;
    this.nameEl = this.el.querySelector('.mp-name')!;
    this.setName(name);

    this.el.addEventListener('pointerdown', (e) => {
      // number keys answer on press, not release: feels like a real keypad
      const k = (e.target as HTMLElement).closest<HTMLElement>('[data-k]');
      if (!k || this.busy) return;
      e.preventDefault();
      this.key(k.dataset.k!);
      k.classList.remove('hit');
      void k.offsetWidth;
      k.classList.add('hit');
    });
    this.el.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('[data-a]');
      if (!b || this.busy) return;
      audio.click();
      switch (b.dataset.a) {
        case 'back':
          this.onBack?.();
          break;
        case 'home':
          this.setView('home');
          break;
        case 'reroll':
          b.classList.remove('roll');
          void b.offsetWidth;
          b.classList.add('roll');
          this.onReroll?.();
          break;
        case 'create':
          this.notice('');
          this.onCreate?.();
          break;
        case 'join':
          this.digits = '';
          this.error('');
          this.setView('join');
          break;
        case 'start':
          this.onStart?.();
          break;
        case 'bots':
          this.onBots?.(!this.room?.settings.bots);
          break;
        case 'garage':
          this.onGarage?.();
          break;
        case 'leave':
          this.onLeave?.();
          break;
        case 'zone':
          this.onZone?.();
          break;
        case 'enterzone':
          this.onEnterZone?.();
          break;
        case 'resume':
          this.onResume?.();
          break;
        case 'share':
          void this.share(b);
          break;
      }
    });
    window.addEventListener('keydown', (e) => {
      if (!this.visible || this.view !== 'join' || this.busy) return;
      if (/^(Digit|Numpad)\d$/.test(e.code)) this.key(e.code.slice(-1));
      else if (e.code === 'Backspace') this.key('del');
      else if (e.code === 'Enter' || e.code === 'NumpadEnter') this.key('ok');
      else if (e.code === 'Escape') this.setView('home');
      else return;
      e.preventDefault();
    });
  }

  private key(k: string) {
    if (k === 'del') {
      this.digits = this.digits.slice(0, -1);
      audio.click();
    } else if (k === 'ok') {
      if (this.digits.length === CODE_LENGTH) this.onJoin?.(this.digits);
      else this.error(`O código tem ${CODE_LENGTH} números.`);
    } else if (this.digits.length < CODE_LENGTH) {
      this.digits += k;
      audio.tone(520 + Number(k) * 40, 0.05, 'triangle', 0.12, 0, audio.ui);
      // the last digit goes straight in
      if (this.digits.length === CODE_LENGTH) setTimeout(() => this.onJoin?.(this.digits), 160);
    }
    if (k !== 'ok') this.error('');
    this.renderCode();
  }

  private renderCode() {
    this.codeEl.querySelectorAll('span').forEach((s, i) => {
      s.textContent = this.digits[i] ?? '';
      s.classList.toggle('on', i < this.digits.length);
      s.classList.toggle('cur', i === this.digits.length);
    });
  }

  /** Open the join pad with a code already filled in (invite links). */
  prefill(code: string) {
    this.digits = code.slice(0, CODE_LENGTH);
    this.setView('join');
  }

  error(msg: string) {
    this.errEl.textContent = msg;
    if (msg) {
      this.codeEl.classList.remove('shake');
      void this.codeEl.offsetWidth;
      this.codeEl.classList.add('shake');
      this.digits = '';
      this.renderCode();
    }
  }

  /** A message on the first page (room closed, couldn't create one…). */
  notice(msg: string) {
    const n = this.el.querySelector('.mp-notice')!;
    n.textContent = msg;
    n.classList.toggle('show', !!msg);
  }

  setBusy(msg: string | null) {
    this.busy = !!msg;
    this.el.classList.toggle('busy', this.busy);
    this.el.querySelector('.mp-busy p')!.textContent = msg ?? '';
  }

  setName(n: string) {

    this.nameEl.textContent = n;
  }

  setView(v: View) {
    this.view = v;
    this.el.dataset.view = v;
    if (v === 'join') this.renderCode();
    if (v === 'lobby') this.renderLobby();
  }

  show(v: boolean) {
    this.visible = v;
    this.el.classList.toggle('hidden', !v);
    if (v) this.setView(this.room ? 'lobby' : this.view === 'lobby' ? 'home' : this.view);
  }

  setRoom(room: Room | null) {
    this.room = room;
    if (room && this.visible) this.setView('lobby');
    if (!room && this.view === 'lobby') this.setView('home');
  }

  /** Redraw the lobby (roster changed). `live`: an online race or zone of mine is still on behind the lobby. */
  renderLobby(live: 'race' | 'zone' | null = this.live) {
    this.live = live;
    const room = this.room;
    if (!room || this.view !== 'lobby') return;
    const racing = live === 'race';
    const zoneOpen = room.session?.kind === 'zone';
    const slots: string[] = [];
    for (let i = 0; i < MAX_PLAYERS; i++) {
      const p = room.players[i];
      if (p) {
        const me = p.id === room.myId;
        slots.push(`<li class="mp-slot full${me ? ' me' : ''}" style="--paint:${paintCss(p.build.paint)}">
          <span class="mp-car"><i></i></span>
          <span class="mp-pname"><b>${esc(p.name)}</b><small>${esc(bodyName(p.build.body))}${me ? ' · TU' : ''}</small></span>
          ${p.host ? '<em class="mp-host">ANFITRIÃO</em>' : `<em class="mp-ping ${p.ping > 180 ? 'bad' : p.ping > 90 ? 'mid' : ''}">${p.ping ? `${p.ping} ms` : '···'}</em>`}
        </li>`);
      } else {
        slots.push(`<li class="mp-slot ${room.settings.bots ? 'bot' : 'empty'}"><span class="mp-car"><i></i></span><span class="mp-pname"><b>${room.settings.bots ? 'RIVAL IA' : 'LIVRE'}</b><small>${room.settings.bots ? 'até alguém entrar' : 'à espera de piloto'}</small></span></li>`);
      }
    }
    const inSession = !!room.session && room.session.at < room.hostNow();
    const banner = racing
      ? '<button class="mp-banner live" data-a="resume">Corrida a decorrer · <b>voltar à pista</b></button>'
      : live === 'zone'
        ? '<button class="mp-banner live zone" data-a="resume">Zona livre a decorrer · <b>voltar à zona</b></button>'
        : zoneOpen
          ? '<button class="mp-banner live zone" data-a="enterzone">Zona livre aberta · <b>entrar</b></button>'
          : inSession && !room.isHost
            ? '<p class="mp-banner">Corrida a decorrer · entras na próxima</p>'
            : '';
    this.lobbyEl.innerHTML = `
      <div class="mp-lobby-top">
        <div class="mp-room">
          <small>SALA</small>
          <div class="mp-bigcode">${room.code.split('').map((d) => `<span>${d}</span>`).join('')}</div>
          <button class="mp-share" data-a="share"><svg viewBox="0 0 24 24"><path d="M12 3v12M7 8l5-5 5 5M5 13v6h14v-6"/></svg><span>Convidar</span></button>
        </div>
        <ol class="mp-slots">${slots.join('')}</ol>
      </div>
      ${banner}
      <div class="mp-lobby-foot">
        <button class="btn small" data-a="leave">Sair da sala</button>
        <button class="btn small" data-a="garage">Garagem</button>
        ${
          room.isHost
            ? `<button class="mp-toggle ${room.settings.bots ? 'on' : ''}" data-a="bots"><i></i>Rivais IA</button>
               ${zoneOpen ? '' : '<button class="btn small mp-zone" data-a="zone">Zona livre</button>'}
               <button class="btn primary mp-start" data-a="start">${racing ? 'Nova corrida' : 'Começar corrida'} ›</button>`
            : '<p class="mp-wait"><span class="mp-dots"><i></i><i></i><i></i></span>À espera que o anfitrião comece</p>'
        }
      </div>`;
  }

  private async share(b: HTMLElement) {
    if (!this.room) return;
    const url = `${location.origin}/?sala=${this.room.code}`;
    const text = `Corre comigo no Hyperdrift! Sala ${this.room.code}`;
    const label = b.querySelector('span')!;
    try {
      if (navigator.share) {
        await navigator.share({ title: 'Hyperdrift', text, url });
        return;
      }
      await navigator.clipboard.writeText(`${text}: ${url}`);
      label.textContent = 'Link copiado!';
    } catch {
      label.textContent = `Código ${this.room.code}`;
    }
    setTimeout(() => (label.textContent = 'Convidar'), 2200);
  }
}
