# Inventário da Sala de Robótica – SENAI

Site estático (HTML + CSS + JS) no GitHub Pages, com **a planilha do Google como banco de dados compartilhado**.
Sem a planilha configurada, o site funciona no "modo antigo" (só `data.json`, sem sincronização — veja o final).

## Como funciona

```
 celular A ─┐                         ┌─ Planilha do Google (abas Pecas, Locais, Categorias)
 celular B ─┼─► site (GitHub Pages) ──┤      ▲
 celular C ─┘    └─ config.js (link)  └─ Apps Script (ponte, protegida por senha do grupo)
```

- Cadastrar, editar, excluir ou contar uma peça: o site grava na planilha em poucos segundos.
- Cada celular busca novidades a cada 15 s (e ao voltar para a aba). O QR Code abre a peça já atualizada.
- Sem internet, as alterações ficam no aparelho e são enviadas quando ela voltar (o indicador ● no topo mostra o estado).
- Duas pessoas na **mesma peça**: vale a alteração mais recente (dados e contagem separadamente). Dividam a contagem por local.
- A planilha tem a coluna **Status** (fórmula) e baixa como Excel: *Arquivo ▸ Fazer download ▸ Microsoft Excel (.xlsx)*.

**Limites:** cada gravação leva 1–2 s; quem souber o link do script **e** a senha pode alterar os dados (não é segurança bancária, é uma trava para o grupo); duas pessoas criando peças com o **mesmo código** ao mesmo tempo (muito raro) viram uma só; o Google limita o uso diário do Apps Script, mas o volume deste trabalho fica muito abaixo.

## Passo a passo

### 1. Planilha e script (use uma conta Google **pessoal**; contas de escola costumam bloquear o passo 4)
1. Em sheets.google.com crie uma planilha em branco, ex.: *Inventário Robótica SENAI*.
2. **Extensões ▸ Apps Script**. Apague o código que aparece, cole **todo** o conteúdo de `planilha/Code.gs`.
3. Na primeira linha de código, troque `'troque-esta-senha'` por uma senha do grupo. Clique em salvar (💾).
4. **Implantar ▸ Nova implantação** ▸ engrenagem ▸ **App da Web**. Em *Executar como*: **Eu**. Em *Quem pode acessar*: **Qualquer pessoa**. Clique **Implantar**.
5. Autorize quando pedir (*Avançado ▸ Acessar … (não seguro)* é normal: o script é seu).
6. Copie o **URL do app da Web** (termina em `/exec`). Cole-o no navegador: deve aparecer "API do inventário ativa".

> Se mudar o `Code.gs` depois, use **Implantar ▸ Gerenciar implantações ▸ ✏️ ▸ Versão: Nova versão ▸ Implantar**. O link continua o mesmo.

### 2. Conectar o site
Abra `config.js` e cole o link: `apiUrl: "https://script.google.com/macros/s/XXXX/exec"`.

### 3. Publicar no GitHub Pages
1. github.com ▸ **New repository** ▸ nome `inventario-robotica` ▸ **Public** ▸ Create.
2. **Add file ▸ Upload files**: envie todos os arquivos e as pastas `vendor` e `planilha` ▸ **Commit changes**.
3. **Settings ▸ Pages** ▸ *Deploy from a branch* ▸ **main** / **(root)** ▸ Save.
4. Em 1–2 min o link aparece: `https://SEU-USUARIO.github.io/inventario-robotica/`. Envie ao grupo.

### 4. Primeiro acesso
Cada pessoa abre o link e digita a senha do grupo **uma vez** por aparelho. Na primeira vez, com a planilha vazia, o site oferece enviar as peças do `data.json` (são exemplos: aceite para testar e apague depois, ou recuse e cadastre as reais). Dá também para importar uma planilha/CSV em *Mais ▸ Importar*.

### 5. Etiquetas
Imprima sempre a partir do **link publicado** (o QR leva o endereço da página aberta). Evite mudar o código de uma peça depois de etiquetada.

## Arquivos
```
index.html  style.css  script.js   o site
config.js                          link do script da planilha
data.json                          carga inicial / backup (modo antigo)
planilha/Code.gs                   script para colar no Apps Script
vendor/qrcode.js                   gerador de QR Code (MIT, offline)
```

## Lista de testes
1. **Conexão:** abra o link no celular A: o indicador mostra "Sincronizado". Veja as abas *Pecas*, *Locais*, *Categorias* na planilha.
2. **Cadastro:** cadastre uma peça no A; ela aparece na planilha e, em até 15 s (ou *Mais ▸ Sincronizar agora*), no celular B.
3. **QR:** escaneie o QR (Detalhes) da peça nova com o B: abre a peça.
4. **Busca e filtros:** código, parte do nome, categoria, local, MAIÚSCULAS; filtros local/categoria/status.
5. **Edição/exclusão:** edite quantidade; exclua com confirmação; confira no outro celular.
6. **Contagem:** *Salvar*, *✓ Bate* e divergente; barra de progresso; coluna Status na planilha.
7. **Conflito:** A e B contam a mesma peça com valores diferentes: vale o último.
8. **Sem internet:** modo avião no A, altere uma peça (indicador "pendente"), volte a internet e toque no indicador: envia.
9. **Edição na planilha:** altere a Quantidade direto na planilha e preencha **EditadoEm** com uma data/hora ISO posterior (ou edite pelo site): o site reflete após sincronizar.
10. **Exportação/importação:** CSV, data.json, baixar .xlsx pelo Google; importar um CSV e *Desfazer última importação*.
11. **Etiquetas:** *Imprimir etiquetas*: QR + código + nome + local.
12. **Senha errada:** num aparelho novo, digite errado: indicador pede a senha de novo.

## Modo antigo (sem planilha)
Se `apiUrl` ficar vazio em `config.js`, o catálogo oficial é o `data.json` do repositório; alterações ficam só no aparelho e são compartilhadas baixando o `data.json` (*Mais ▸ Baixar data.json*) e publicando no GitHub, ou importando o arquivo de cada colega.
