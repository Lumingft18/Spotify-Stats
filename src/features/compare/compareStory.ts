// The comparison told in words. Every sentence is built from computed numbers (nothing generated or invented);
// a sentence is dropped when its data is missing or not meaningful.
import { fmtDate, fmtHours, fmtInt, fmtMonth, fmtPct } from '../../lib/format';
import { moodLabel } from '../../lib/mood';
import type { Comparison } from './compareData';

/** "il 3 nov 2025" / "l’8 nov 2025" / "l’11 …" */
const ilData = (d: string | null | undefined) => {
  const t = fmtDate(d);
  return /^(8|11)\b/.test(t) ? `l’${t}` : `il ${t}`;
};
const ratio = (a: number, b: number) => (b ? a / b : 0);
const times = (r: number) => (r >= 1.15 ? `${r.toFixed(1).replace('.', ',')} volte` : '');
const years = (days: number) => (days >= 365 ? `${(days / 365).toFixed(1).replace('.', ',')} anni` : `${fmtInt(days)} giorni`);

function affinityWord(score: number) {
  if (score >= 80) return 'anime gemelle musicali';
  if (score >= 65) return 'molto vicini';
  if (score >= 50) return 'vicini, con le vostre differenze';
  if (score >= 35) return 'mondi che si toccano';
  return 'due mondi diversi';
}

export function narrateComparison(c: Comparison, them: string): Array<{ title: string; text: string }> {
  const out: Array<{ title: string; text: string }> = [];
  const part = (k: string) => c.parts.find((p) => p.key === k)?.value ?? null;
  const strongest = [...c.parts].sort((a, b) => b.value - a.value)[0];
  const weakest = [...c.parts].sort((a, b) => a.value - b.value)[0];

  // 1. Verdict
  out.push({
    title: 'In una frase',
    text: `Tu e ${them} siete ${affinityWord(c.score)}: affinità ${c.score} su 100. Vi somigliate soprattutto per ${strongest.label.toLowerCase()} (${Math.round(strongest.value * 100)}), molto meno per ${weakest.label.toLowerCase()} (${Math.round(weakest.value * 100)}).${
      (part('genres') ?? 0) - (part('artists') ?? 0) > 0.3
        ? ` In pratica amate gli stessi generi ma li ascoltate attraverso artisti diversi: stesso territorio, strade diverse.`
        : ''
    }`,
  });

  // 2. Volumes
  const r = ratio(c.me.hours, c.them.hours);
  const more = r >= 1 ? 'tu' : them;
  const rr = r >= 1 ? r : 1 / r;
  out.push({
    title: 'Quanta musica',
    text: `${c.overlap ? `Le vostre storie si sovrappongono dal ${fmtDate(c.overlap.from)} al ${fmtDate(c.overlap.to)}. ` : ''}In tutto hai ascoltato ${fmtInt(c.me.hours)} ore, ${them} ${fmtInt(c.them.hours)}${
      times(rr) ? `: ${more === 'tu' ? 'tu ne hai' : `${them} ne ha`} ascoltate ${times(rr)} tanto` : ''
    }. ${
      c.them.artists > c.me.artists * 1.3
        ? `${them} esplora di più: ${fmtInt(c.them.artists)} artisti diversi contro i tuoi ${fmtInt(c.me.artists)}, e il ${fmtPct(c.them.novelty)} del suo ascolto va a brani appena scoperti (tu ${fmtPct(c.me.novelty)}).`
        : c.me.artists > c.them.artists * 1.3
          ? `Esplori più tu: ${fmtInt(c.me.artists)} artisti diversi contro ${fmtInt(c.them.artists)} di ${them}.`
          : `Avete un numero simile di artisti diversi (${fmtInt(c.me.artists)} e ${fmtInt(c.them.artists)}).`
    }`,
  });

  // 3. Shared people
  const sa = c.sharedArtists.slice(0, 3).map((s) => s.artist);
  if (sa.length) {
    const top = c.sharedArtists[0];
    out.push({
      title: 'Chi vi unisce',
      text: `Il punto d’incontro più forte è ${sa.length > 1 ? `${sa.slice(0, -1).join(', ')} e ${sa[sa.length - 1]}` : sa[0]}. ${top.artist} da solo vale ${fmtHours(top.me)} per te e ${fmtHours(top.them)} per ${them}. ${
        c.yearsDetail.filter((y) => y.shared).length
          ? `In ${c.yearsDetail.filter((y) => y.shared).length === 1 ? 'un anno' : `${c.yearsDetail.filter((y) => y.shared).length} anni`} avete avuto lo stesso artista dell’anno (${c.yearsDetail.filter((y) => y.shared).map((y) => `${y.me} nel ${y.year}`).join(', ')}).`
          : `Non avete mai avuto lo stesso artista dell’anno: ${c.topArtists.me[0]?.label ?? '—'} è il tuo di sempre, ${c.topArtists.them[0]?.label ?? '—'} il suo.`
      }`,
    });
  }

  // 4. Time
  if (c.byYear.length >= 2) {
    const best = c.byYear.reduce((b, y) => (y.affinity > b.affinity ? y : b));
    const worst = c.byYear.reduce((b, y) => (y.affinity < b.affinity ? y : b));
    const last = c.byYear[c.byYear.length - 1];
    const first = c.byYear[0];
    const trend = last.affinity - first.affinity;
    out.push({
      title: 'Nel tempo',
      text: `Siete stati più vicini nel ${best.year} e più lontani nel ${worst.year}. ${
        Math.abs(trend) > 0.05 ? (trend > 0 ? `Col tempo vi state avvicinando: dal ${first.year} al ${last.year} l’affinità sugli artisti è salita.` : `Col tempo vi siete allontanati: dal ${first.year} al ${last.year} l’affinità sugli artisti è scesa.`) : 'L’affinità è rimasta stabile negli anni.'
      }`,
    });
  }

  // 5. Discoveries
  const ff = c.firstFound;
  if (ff.meFirst + ff.themFirst >= 5) {
    const ex = ff.examples[0];
    const leader = ff.meFirst > ff.themFirst * 1.2 ? 'tu' : ff.themFirst > ff.meFirst * 1.2 ? them : null;
    out.push({
      title: 'Chi ha scoperto prima',
      text: `Tra gli artisti che amate entrambi, ${fmtInt(ff.meFirst)} li hai scoperti prima tu e ${fmtInt(ff.themFirst)} ${them}. ${
        leader ? `${leader === 'tu' ? 'Sei tu' : `È ${them}`} quello che arriva prima.` : 'Siete pari: vi passate la musica a vicenda.'
      }${ex ? ` Esempio: ${ex.artist}, ${ex.leadDays > 0 ? 'tu' : them} ${years(Math.abs(ex.leadDays))} prima.` : ''}`,
    });
  }

  // 6. Sync
  if (c.sync.days > 0) {
    const ex = c.sync.examples[0];
    out.push({
      title: 'In sincronia',
      text: `In ${fmtInt(c.sync.days)} giorni avete ascoltato lo stesso brano lo stesso giorno, senza saperlo (${fmtInt(c.sync.tracks)} brani diversi), e in ${fmtInt(c.sync.sameArtistDays)} giorni lo stesso artista.${
        ex ? ` L’ultima volta: “${ex.track}” di ${ex.artist}, ${ilData(ex.day)}.` : ''
      }`,
    });
  }

  // 7. Mood
  const mMe = [...c.moodMix].sort((a, b) => b.me - a.me)[0];
  const mThem = [...c.moodMix].sort((a, b) => b.them - a.them)[0];
  if (mMe && mThem && c.me.valence != null && c.them.valence != null) {
    const dv = (c.them.valence - c.me.valence) * 100;
    out.push({
      title: 'Il suono',
      text: `Il tuo suono è soprattutto ${moodLabel(mMe.mood).toLowerCase()} (${fmtPct(mMe.me)}), quello di ${them} ${moodLabel(mThem.mood).toLowerCase()} (${fmtPct(mThem.them)}). ${
        Math.abs(dv) >= 3 ? `${dv > 0 ? `${them} ascolta` : 'Ascolti tu'} musica in media più positiva (${fmtInt(Math.max(c.me.valence, c.them.valence) * 100)} contro ${fmtInt(Math.min(c.me.valence, c.them.valence) * 100)} su 100).` : 'La positività media è quasi identica.'
      }${
        c.records.me.happiestYear && c.records.them.happiestYear
          ? c.records.me.happiestYear.year === c.records.them.happiestYear.year
            ? ` L’anno più solare è lo stesso per entrambi: il ${c.records.me.happiestYear.year}.`
            : ` Il tuo anno più solare è il ${c.records.me.happiestYear.year}, il suo il ${c.records.them.happiestYear.year}.`
          : ''
      }`,
    });
  }

  // 8. Habits
  const skipDiff = c.them.skip - c.me.skip;
  out.push({
    title: 'Abitudini',
    text: `${c.me.peakHour === c.them.peakHour ? `Il vostro momento è lo stesso: le ${c.me.peakHour}:00.` : `Il tuo picco è alle ${c.me.peakHour}:00, quello di ${them} alle ${c.them.peakHour}:00.`} ${
      Math.abs(c.them.night - c.me.night) > 0.03 ? `${c.them.night > c.me.night ? `${them} è più nottambulo` : 'Sei più nottambulo tu'} (${fmtPct(Math.max(c.me.night, c.them.night))} dell’ascolto dopo mezzanotte). ` : ''
    }${
      Math.abs(skipDiff) > 0.08 ? `${skipDiff > 0 ? `${them} salta` : 'Salti tu'} molto di più: ${fmtPct(Math.max(c.me.skip, c.them.skip))} dei brani contro ${fmtPct(Math.min(c.me.skip, c.them.skip))}. ` : ''
    }Ascoltate su ${c.me.topDevice === c.them.topDevice ? `lo stesso dispositivo principale (${c.me.topDevice})` : `dispositivi diversi: tu ${c.me.topDevice}, ${them} ${c.them.topDevice}`}.`,
  });

  // 9. Records
  const rm = c.records.me;
  const rt = c.records.them;
  if (rm.streak && rt.streak) {
    out.push({
      title: 'Record',
      text: `La tua serie più lunga è di ${fmtInt(rm.streak.days)} giorni di fila, quella di ${them} di ${fmtInt(rt.streak.days)}. Il tuo giorno record: ${fmtHours((rm.topDay?.hours ?? 0) * 60)} ${ilData(rm.topDay?.day)}; il suo: ${fmtHours((rt.topDay?.hours ?? 0) * 60)} ${ilData(rt.topDay?.day)}.${
        rm.topMonth && rt.topMonth ? ` I mesi più intensi: ${fmtMonth(rm.topMonth.ym)} per te, ${fmtMonth(rt.topMonth.ym)} per ${them}.` : ''
      }`,
    });
  }

  // 10. Swap
  const give = c.myGems.slice(0, 3).map((g) => g.artist);
  const get = c.theirGems.slice(0, 3).map((g) => g.artist);
  if (give.length || get.length) {
    out.push({
      title: 'Da scambiarvi',
      text: `${get.length ? `Da ${them} potresti scoprire ${get.join(', ')}` : ''}${get.length && give.length ? '; ' : ''}${give.length ? `tu potresti fargli sentire ${give.join(', ')}` : ''}. ${
        c.sharedTracks[0] ? `E se cercate una canzone vostra: “${c.sharedTracks[0].track}” di ${c.sharedTracks[0].artist}.` : ''
      }`,
    });
  }
  return out;
}
