# Atualização diária em nuvem

Configuração de 13/10/2026: coleta diária às 06h e verificação às 07h de
Brasília. O ambiente `production` ativa o cron; a configuração padrão o pausa.
A conta Cloudflare foi conferida no plano Free. Nenhum plano pago foi ativado.

## Funcionamento

- **06h de Brasília:** Cloudflare solicita `Refresh BR ratios`. O job confere
  parceiros, taxas, estimativas de valor e prazos com fonte, testa e salva as mudanças verificadas.
  Sua conclusão dispara `Build feed`: promoções, histórico, validação e Pages.
- **07h:** verifica o resultado do job de taxas e a publicação efetiva. O feed
  e suas fontes precisam ter sido verificados depois da conclusão do job de
  taxas. Essa chamada não faz nova coleta.
- Não há outro cron no GitHub nessa configuração, evitando a segunda coleta
  diária. Os dois workflows continuam disponíveis para execução manual.
- A extensão avisa quando o feed passa de **36 horas**. A checagem das 07h
  detecta a falta da publicação do dia antes desse prazo. A expiração das
  promoções continua ocorrendo pelo relógio, sem depender de nova coleta.

O Worker evita solicitar execução já recente/em andamento. Eventos simultâneos
ainda podem passar por essa consulta; os workflows serializam as execuções e
atualizam dados de forma idempotente. Não é garantia de execução exatamente uma
vez. Falhas de cron ficam registradas no Cloudflare. **Nenhum canal novo de
notificação externa foi configurado.** Permanecem os registros de erro existentes
no GitHub.

## Custo previsto: zero, dentro das franquias

São um cron e duas invocações por dia, sem KV, banco ou endpoint público.
O Workers Free inclui 100 mil invocações/dia, 10 ms de CPU/invocação e até cinco
crons por conta. A espera da rede não conta como CPU. Os limites são
compartilhados com outros Workers; conferir capacidade antes da ativação.
O dry-run valida o build, não mede CPU em produção. Não habilitar plano pago.

O repositório `lucasmlessa-hash/transfer-radar-data` foi confirmado público,
com runners padrão, cujos minutos são gratuitos. Os artefatos Pages são
pequenos/temporários; armazenamento continua sujeito à franquia da conta.

Fontes verificadas em 13/10/2026:

- [Preços Workers](https://developers.cloudflare.com/workers/platform/pricing/)
- [Limites Workers](https://developers.cloudflare.com/workers/platform/limits/)
- [Cron em UTC](https://developers.cloudflare.com/workers/configuration/cron-triggers/)
- [GitHub Actions: gratuidade e armazenamento](https://docs.github.com/en/billing/concepts/product-billing/github-actions)

## Credencial necessária

Token GitHub **fine-grained** criado e salvo como segredo no Worker, restrito ao repositório
`transfer-radar-data`, com **Actions: Read and write**, válido até **13/10/2027**.
Renovar antes dessa data: token expirado interrompe o agendamento. Não precisa de permissão Contents.
[Permissões oficiais](https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event).

Não reutilizar o token amplo de `gh auth`, nem colocar segredo no chat, código
ou argumento de comando. Salvar apenas como secret `GITHUB_TOKEN` do Worker,
usando o prompt interativo do Wrangler ou o campo protegido do Cloudflare.

## Ativação

1. Conferir plano e disponibilidade de um cron na conta Cloudflare. Este Worker
   tem nome próprio e não modifica o projeto Refúgio.
2. Publicar o Worker **sem cron**, a partir da raiz do repositório de dados:

   ```sh
   npx wrangler@4.92.0 deploy --config cloud-scheduler/wrangler.jsonc
   npx wrangler@4.92.0 secret put GITHUB_TOKEN --config cloud-scheduler/wrangler.jsonc --env production
   ```

3. Publicar os workflows, testes e prazo de 36h no repositório de dados,
   preservando ledger remoto e commits do bot. Nunca usar force-push.
4. Disparar `Refresh BR ratios` manualmente. Conferir seu resultado, o build
   encadeado e a data do feed publicado. Se falhar, manter/restaurar o cron antigo
   até o reparo, sem apagar o último feed válido.
5. Ativar o relógio:

   ```sh
   npx wrangler@4.92.0 deploy --config cloud-scheduler/wrangler.jsonc --env production
   ```

6. Confirmar que o secret existe pelo nome, sem imprimir o valor. A propagação
   do cron pode levar 15 minutos. Acompanhar as execuções reais das 06h/07h:
   dry-run e aceite HTTP do GitHub não comprovam coleta concluída. Recarregar
   a extensão para aplicar o prazo diário no painel.

Para pausar, publicar a configuração padrão, sem `--env production`, com a lista
de crons vazia. Essa ação deixa apenas execuções manuais; para voltar ao GitHub
temporariamente, restaurar um cron diário no workflow de taxas. Preparação e
produção usam o mesmo nome de Worker; escolher o ambiente deliberadamente.

## Verificação local

```sh
npm test
npx wrangler@4.92.0 deploy --dry-run --config cloud-scheduler/wrangler.jsonc --env production
```

Os testes simulam apenas o transporte HTTP: token ausente/negado, aceite 200/204,
duplicatas, falha nas taxas, feed antigo ou anterior às taxas, fonte ausente,
cobertura parcial, datas futuras e isolamento da credencial. Não disparam
workflows reais nem usam tokens reais.

## Cobertura e limites

- Diretórios e razões dos bancos US/BR: conectores existentes, conferidos diariamente.
- Hotéis: Marriott 8/8, Choice 2/2 e Wyndham 1/2 das rotas cadastradas, pelas fontes oficiais.
  Wyndham → United permanece sem taxa base confirmada, exibida como `—`. A API
  não separa claramente o bônus da taxa base; o relatório registra essa lacuna.
  Novas parcerias de hotéis fora das rotas cadastradas ainda exigem ampliar o diretório.
- Estimativas de resgate: 24 programas conferidos no Frequent Miler/TPG; 13 valores
  legados sem revalidação automática ficam fora dos cálculos quando não têm
  fonte válida ou revisão de até 35 dias. Não são preços garantidos de milhas.
- Prazos: 98 rotas com estimativa explícita no Frequent Miler na ativação. As
  demais permanecem sem prazo confirmado. São observações, não SLA dos programas.

Os relatórios `hotel-ratios-health.json`, `point-valuations-health.json` e
`transfer-times-health.json` acompanham o feed publicado. Falha não renova a
data de conferência, e mudanças verificadas de fontes independentes podem ser
publicadas mesmo quando outra fonte falha. Nenhum scraper garante cobrir todo o
mercado ou promoções lançadas e encerradas entre duas coletas diárias.
