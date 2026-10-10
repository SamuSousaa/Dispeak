/** A compact, built-in emoji set. The system keyboard (Win + . on Windows) covers the rest. */
export const EMOJI_GROUPS: Array<{ label: string; emojis: string[] }> = [
  {
    label: 'CARINHAS',
    emojis: [
      ...'😀😁😂🤣😅😊😇🙂🙃😉😍🥰😘😋😛😜🤪🤨🧐🤓😎🥳😏😒😞😔😟😕🙁😣😖😫😩🥺😢😭😤😠😡🤬🤯😳🥵🥶😱😨😰😥🤗🤔🤭🤫🤥😶😐😑😬🙄😯😮😲🥱😴🤤😵🤐🥴🤢🤮🤧😷🤒🤕🤑🤠😈👿💀👻👽🤖💩🤡',
    ],
  },
  {
    label: 'GESTOS',
    emojis: [...'👍👎👌🤌🤏🤞🤟🤘🤙👈👉👆👇👋🤚🖐✋🖖👏🙌🤝🙏💪🫡🫠🫶👀🧠🫵'],
  },
  {
    label: 'CORAÇÕES E SÍMBOLOS',
    emojis: [...'💔💖💙💚💛🧡💜🖤🤍🤎💯💢💥💫💦💤🔥⭐🌟✨⚡🎉🎊🏆🥇🎯✅❌❓❗⚠🚫'],
  },
  {
    label: 'JOGOS E COISAS',
    emojis: [...'🎮🕹🎧🎤🎬📸💻🖥⌨🖱📱🔊🔇🎵🎶⚽🏀🏈🎲🃏🚀🛸💣🔫🗡🛡💰💎🍕🍔🍟🌮🍿🍺🍻☕🧃'],
  },
  {
    label: 'BICHOS',
    emojis: [...'🐶🐱🐭🐹🐰🦊🐻🐼🐨🐯🦁🐮🐷🐸🐵🙈🙉🙊🐔🐧🐦🦆🦉🐺🐴🦄🐝🐛🦋🐢🐍🐙🦈🐳🦖'],
  },
];
