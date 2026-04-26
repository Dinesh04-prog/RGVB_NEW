import Sanscript from '@sanskrit-coders/sanscript';

export const HINGLISH_TO_MARATHI: Record<string, string> = {
  "chaha": "चहा", "powder": "पावडर", "masala": "मसाला", "pith": "पीठ",
  "lal": "लाल", "mirchi": "मिरची", "sakhar": "साखर", "tandul": "तांदूळ", 
  "dudh": "दूध", "halad": "हळद", "jeera": "जिरे", "mohari": "मोहरी", 
  "kaju": "काजू", "badam": "बदाम", "pohe": "पोहे", "rava": "रवा", 
  "besan": "बेसन", "atta": "गव्हाचे", "tel": "तेल", "tup": "तूप",
  "shingdana": "शेंगदाणा", "shengdana": "शेंगदाणा", "meet": "मीठ",
  "mith": "मीठ", "gud": "गूळ", "gul": "गूळ", "udid": "उडीद",
  "sabudana": "साबुदाणा"
};

export const translateHinglishToMarathi = (query: string): string => {
  if (!query) return "";
  
  const words = query.split(/\s+/);
  const translated = words.map(word => {
     // Check if it's purely english letters
     if (!/^[a-zA-Z]+$/.test(word)) return word;
     
     const lower = word.toLowerCase();
     if (HINGLISH_TO_MARATHI[lower]) return HINGLISH_TO_MARATHI[lower];
     
     // Morphological adjustments for Hindi/Marathi ITRANS compatibility
     let itrans = word
        .replace(/aa/g, 'A')
        .replace(/ee/g, 'I')
        .replace(/oo/g, 'U')
        .replace(/sh/g, 'Sh')
        .replace(/ch/g, 'ch')
        .replace(/chh/g, 'Ch');
        
     try {
       return Sanscript.t(itrans, 'itrans', 'devanagari');
     } catch (e) {
       return word;
     }
  });

  return translated.join(" ");
};

