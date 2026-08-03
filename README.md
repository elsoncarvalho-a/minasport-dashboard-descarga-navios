# MinasPort - Torre de Controle de Descarga de Navios

Dashboard web estático para acompanhamento executivo e analítico da produtividade de descarga. O projeto lê a planilha operacional diretamente no navegador, recalcula os indicadores e permite exportar a operação selecionada em PDF.

## Como usar

1. Abra o site publicado no GitHub Pages.
2. Selecione o **navio** e, em seguida, a **operação** correspondente.
3. Para analisar uma atualização sem publicar o arquivo, clique em **Atualizar dados** e escolha o Excel local. O processamento ocorre somente no navegador.
4. A última planilha selecionada fica salva automaticamente nesse navegador e será restaurada nas próximas visitas. Clique em **Usar base padrão** para apagar a cópia local.
5. Para disponibilizar a mesma atualização a todos os usuários, substitua o arquivo `data/Torre_Controle_Produtividade_Descarga_Navios.xlsx` no repositório e faça um novo commit.
6. Clique em **Baixar PDF** para gerar o relatório completo da operação selecionada.

## Indicadores disponíveis

- Volume manifestado, descarregado, saldo e aderência ao manifesto.
- Status parcial enquanto o volume descarregado estiver abaixo da carga informada; fechamento somente ao atingir o volume manifestado.
- Volume direto e via terminal, participação de cada fluxo e produtividade por fluxo.
- Produtividade média, meta, atingimento e desvio.
- Prancha média em 24 horas, meta e atingimento.
- Horas de operação, horas trabalhadas, horas paradas, percentual de paradas e eficiência.
- Quantidade de paradas, duração média, maior parada e horas perdidas por 1.000 toneladas.
- Quantidade de porões operados, tempo médio, saldo, aderência e produtividade por porão.
- Volume, participação, horas, paradas, eficiência e produtividade por turno.
- Evolução diária de volume, produtividade e eficiência.
- Paradas por categoria e por motivo, com ocorrências, duração e participação.
- Melhor e menor desempenho por turno e por porão.
- Perfil da operação: navio, IMO, bandeira, terminal, berço, produto, cliente, tipo, ETB e ETS.

## Estrutura esperada do Excel

O painel requer as abas:

- `Cadastro_Navio`
- `Base_Porao_Turno`
- `Paradas_Detalhadas`
- `Poroes_Resumo`

As fórmulas do dashboard são refeitas a partir dos lançamentos dessas abas. Assim, a visualização não depende dos valores calculados previamente pelo Excel.

## Execução local

Sirva a pasta por HTTP; abrir o `index.html` diretamente pode bloquear o carregamento da planilha por segurança do navegador.

```bash
python -m http.server 8000
```

Depois acesse `http://localhost:8000`.

## Publicação

O workflow em `.github/workflows/pages.yml` publica automaticamente o conteúdo da branch `main` no GitHub Pages. Em **Settings > Pages**, configure a fonte como **GitHub Actions**.

> Atenção: um site do GitHub Pages pode ficar acessível publicamente. Antes de publicar, confirme que os dados operacionais da planilha podem ser expostos fora da empresa.

## Bibliotecas incorporadas

- [SheetJS Community Edition 0.20.3](https://docs.sheetjs.com/docs/getting-started/installation/standalone/) para leitura do Excel no navegador.
- [html2canvas 1.4.1](https://html2canvas.hertzen.com/) e [jsPDF 2.5.1](https://github.com/parallax/jsPDF) para exportação do painel em PDF A3.
