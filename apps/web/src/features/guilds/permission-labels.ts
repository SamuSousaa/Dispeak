import { Permissions, type ChannelType, type PermissionName } from '@frequencia/shared';

export interface PermissionInfo {
  name: PermissionName;
  bit: bigint;
  label: string;
  description: string;
  /** Channel types where an overwrite for it makes sense. */
  channels: ChannelType[];
}

const everywhere: ChannelType[] = ['text', 'voice', 'category'];

export const PERMISSION_INFO: PermissionInfo[] = [
  {
    name: 'ViewChannel',
    bit: Permissions.ViewChannel,
    label: 'Ver canais',
    description: 'Ver o canal e ler o histórico.',
    channels: everywhere,
  },
  {
    name: 'SendMessages',
    bit: Permissions.SendMessages,
    label: 'Enviar mensagens',
    description: 'Escrever nos canais de texto e no chat dos canais de voz.',
    channels: everywhere,
  },
  {
    name: 'ManageMessages',
    bit: Permissions.ManageMessages,
    label: 'Gerenciar mensagens',
    description: 'Excluir mensagens de outros membros.',
    channels: everywhere,
  },
  {
    name: 'MentionEveryone',
    bit: Permissions.MentionEveryone,
    label: 'Mencionar @todos',
    description: 'Notificar todos os membros de uma vez.',
    channels: everywhere,
  },
  {
    name: 'AttachFiles',
    bit: Permissions.AttachFiles,
    label: 'Anexar imagens',
    description: 'Enviar imagens junto com as mensagens.',
    channels: everywhere,
  },
  {
    name: 'AddReactions',
    bit: Permissions.AddReactions,
    label: 'Reagir a mensagens',
    description: 'Adicionar reações com emoji.',
    channels: everywhere,
  },
  {
    name: 'Connect',
    bit: Permissions.Connect,
    label: 'Conectar',
    description: 'Entrar em canais de voz.',
    channels: ['voice', 'category'],
  },
  {
    name: 'Speak',
    bit: Permissions.Speak,
    label: 'Falar',
    description: 'Transmitir o microfone.',
    channels: ['voice', 'category'],
  },
  {
    name: 'Stream',
    bit: Permissions.Stream,
    label: 'Transmitir tela',
    description: 'Compartilhar a tela e ligar a câmera em canais de voz.',
    channels: ['voice', 'category'],
  },
  {
    name: 'MuteMembers',
    bit: Permissions.MuteMembers,
    label: 'Mutar membros',
    description: 'Tirar o microfone de membros de cargo inferior, em todos os canais de voz.',
    channels: [],
  },
  {
    name: 'DisconnectMembers',
    bit: Permissions.DisconnectMembers,
    label: 'Desconectar membros',
    description: 'Tirar membros de cargo inferior de uma chamada.',
    channels: [],
  },
  {
    name: 'CreateInvite',
    bit: Permissions.CreateInvite,
    label: 'Criar convites',
    description: 'Convidar novas pessoas para o servidor.',
    channels: [],
  },
  {
    name: 'KickMembers',
    bit: Permissions.KickMembers,
    label: 'Expulsar membros',
    description: 'Remover membros de cargo inferior.',
    channels: [],
  },
  {
    name: 'BanMembers',
    bit: Permissions.BanMembers,
    label: 'Banir membros',
    description: 'Remover membros de cargo inferior e impedir que voltem.',
    channels: [],
  },
  {
    name: 'ManageChannels',
    bit: Permissions.ManageChannels,
    label: 'Gerenciar canais',
    description: 'Criar, editar, reordenar e excluir canais.',
    channels: everywhere,
  },
  {
    name: 'ManageRoles',
    bit: Permissions.ManageRoles,
    label: 'Gerenciar cargos',
    description: 'Criar e atribuir cargos abaixo do seu, e editar permissões de canais.',
    channels: everywhere,
  },
  {
    name: 'ManageGuild',
    bit: Permissions.ManageGuild,
    label: 'Gerenciar servidor',
    description: 'Renomear o servidor e administrar convites.',
    channels: [],
  },
  {
    name: 'Administrator',
    bit: Permissions.Administrator,
    label: 'Administrador',
    description: 'Todas as permissões, ignorando restrições de canais.',
    channels: [],
  },
];
