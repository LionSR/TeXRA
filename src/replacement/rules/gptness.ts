// Local imports - replacement
import { ReplacementCategory } from '../types';

export const GPTNESS_REPLACEMENTS: ReplacementCategory = {
  name: 'gptness',
  description: 'GPTness improvements',
  isRegex: false,
  patterns: {
    'delve into': 'discuss',
    'delves into': 'discusses',
    'delving into': 'discussing',
    disparate: 'different',
    disseminates: 'distributes',
    disseminated: 'distributed',
    disseminating: 'distributing',
    dissemination: 'distribution',
    disseminations: 'distributions',
    parsimonious: 'simple',
    embark: 'start',
    realm: 'area',
    intricate: 'complex',
    '"exact"': "``exact''",

    "It's important to note": 'Note that',
    'our exploration': 'our discussion',
    'inter-layer': 'interlayer',
    'Near the 50\\%': 'Near 50\\%',
    'on the order of': 'of the order of',
    'improves consistently': 'consistently improves',
    'with results shown': 'with the results shown',
    'imaginary time evolution': 'imaginary-time evolution',
    showcasing: 'showing',
    'paradigm shift': 'big change',
    envisage: 'imagine',
    // parameterizing: 'parametrizing',
    Normalising: 'Normalizing',
    conditon: 'condition',
    necessitates: 'requires',
    Itô: 'Ito',
    k_BT: 'k_B T',

    // Sophisticated single words (user curated)
    myriad: 'many',
    multitude: 'many',
    amalgamation: 'combination',
    culminate: 'end',
    expedite: 'speed up',
    leverage: 'use',
    commence: 'begin',
    elucidate: 'explain',
    ascertain: 'determine',
    paramount: 'important',
    quintessential: 'essential',
    imperative: 'important',
    peruse: 'read',
    cognizant: 'aware',
    nascent: 'new',
    ostensibly: 'apparently',
    conundrum: 'problem',
    efficacy: 'effectiveness',
    deleterious: 'harmful',
    salient: 'prominent',
    precipitate: 'cause', // as a verb
    ubiquitous: 'common',
    underscore: 'emphasize',
    proffer: 'offer',
    surmise: 'guess',
    burgeon: 'grow',
    expound: 'explain',

    // Sophisticated/Formal GPT Expressions (user curated)
    'it is imperative to': 'we must',
    'it is paramount that': 'it is crucial that',
    'of paramount importance': 'very important',
    'it is incumbent upon us to': 'we should',
    'the crux of the matter is': 'the main point is',
    'in light of the fact that': 'because',
    'by virtue of the fact that': 'because',
    'aforementioned discussion': 'this discussion',
    'in the affirmative': 'yes',
    'in the negative': 'no',
    'serves to illustrate': 'shows',
    'render it necessary to': 'require',
    'exhibits a tendency to': 'tends to',
    'have a bearing on': 'affect',
    'bear resemblance to': 'resemble',
    'in consequence of': 'because of',
    'subsequent to our analysis': 'after our analysis',

    // Additional Formal GPT Expressions based on feedback
    'it stands to reason that': 'it follows that', // or 'logically'
    'at this juncture': 'now', // or 'at this point'
    'in the first instance': 'firstly',
    'for the duration of': 'during',
    'be that as it may': 'however', // or 'despite that'
    // 'in accordance with': 'according to', // or 'following'
    'make endeavors to': 'try to',
    'is indicative of': 'indicates',
    'holds true for': 'applies to',
    'bring to fruition': 'complete', // or 'achieve'

    // Top GPT-isms (marketing/cliche phrases)
    'dive deeper into': 'study',
    'harness the power': 'use',
    'seamlessly integrate': 'integrate',
    'leveraging the capabilities': 'using',
    'ultimate guide to': 'guide to',
    'mastering the art of': 'learning',
    'empower you to': 'help you',

    // Additional GPT-isms
    brittle: 'fragile',
    // 'deeper understanding': 'better understanding',
    // 'are essential': 'are important',
    // novel: 'new',
    // explore: 'study',
    // fostering: 'promoting',
    // pivotal: 'important',
  },
};

export default GPTNESS_REPLACEMENTS;
