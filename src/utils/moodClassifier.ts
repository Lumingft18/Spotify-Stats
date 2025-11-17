import type { MoodCategory } from '../types';

/**
 * Classificatore del mood basato sul modello a quadranti
 * Utilizza Valence (X) ed Energy (Y) per classificare le canzoni in 5 categorie principali
 * 
 * @param valence Valore di valenza da 0.0 a 1.0 (0.0 = triste, 1.0 = felice)
 * @param energy Valore di energia da 0.0 a 1.0 (0.0 = calma, 1.0 = intensa)
 * @param threshold Soglia di divisione (default: 0.5)
 * @param neutralRange Range per considerare un valore "neutrale" (default: 0.05, quindi 0.45-0.55)
 * @returns Categoria del mood
 */
export function get_mood(
  valence: number,
  energy?: number,
  threshold: number = 0.5,
  neutralRange: number = 0.05
): MoodCategory {
  // Valida i parametri
  if (valence === null || valence === undefined || isNaN(valence)) {
    return 'sconosciuto';
  }

  // Se energy non è disponibile, usa solo valence (fallback a comportamento simile a v1 ma con soglia 0.5)
  if (energy === null || energy === undefined || isNaN(energy)) {
    if (valence >= threshold + neutralRange) {
      return 'euforico'; // Approssimazione: alta valence senza energy → sereno/euforico
    } else if (valence <= threshold - neutralRange) {
      return 'malinconico'; // Bassa valence senza energy → malinconico
    } else {
      return 'neutrale';
    }
  }

  // Normalizza i valori tra 0 e 1
  const normalizedValence = Math.max(0, Math.min(1, valence));
  const normalizedEnergy = Math.max(0, Math.min(1, energy));

  // Calcola i range neutri
  const valenceLowerBound = threshold - neutralRange;
  const valenceUpperBound = threshold + neutralRange;
  const energyLowerBound = threshold - neutralRange;
  const energyUpperBound = threshold + neutralRange;

  // Gestione dei casi "neutri" - quando i valori sono molto vicini alla soglia
  // IMPORTANTE: "neutrale" solo se ENTRAMBI i valori sono nella zona neutra
  // Se solo uno è neutro, procedi con la classificazione a quadranti normale
  const isValenceNeutral = normalizedValence >= valenceLowerBound && normalizedValence <= valenceUpperBound;
  const isEnergyNeutral = normalizedEnergy >= energyLowerBound && normalizedEnergy <= energyUpperBound;

  // Se entrambi i valori sono nella zona neutra, classifica come neutrale
  // Questa è la PRIMA verifica da fare (priorità massima)
  if (isValenceNeutral && isEnergyNeutral) {
    return 'neutrale';
  }

  // Classificazione a quadranti
  // Quadrante 1: Alta Valence (> threshold) + Alta Energy (> threshold)
  // Mood: Euforico
  if (normalizedValence > threshold && normalizedEnergy > threshold) {
    return 'euforico';
  }

  // Quadrante 2: Alta Valence (> threshold) + Bassa Energy (<= threshold)
  // Mood: Sereno
  if (normalizedValence > threshold && normalizedEnergy <= threshold) {
    return 'sereno';
  }

  // Quadrante 3: Bassa Valence (<= threshold) + Alta Energy (> threshold)
  // Mood: Arrabbiato
  if (normalizedValence <= threshold && normalizedEnergy > threshold) {
    return 'arrabbiato';
  }

  // Quadrante 4: Bassa Valence (<= threshold) + Bassa Energy (<= threshold)
  // Mood: Malinconico
  if (normalizedValence <= threshold && normalizedEnergy <= threshold) {
    return 'malinconico';
  }

  // Fallback (non dovrebbe mai arrivare qui)
  return 'neutrale';
}


