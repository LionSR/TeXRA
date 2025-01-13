\NeedsTeXFormat{LaTeX2e}[2007/10/19]
\ProvidesClass{exercise}[2024/03/24 v0.0.3 The LaTeX template for problem sets]
\typeout{Document Class `exercise' v0.0.3 by Sirui Lu (2024/03/24)}

%%% class options %%%
\newif\iffl@colorlinks
\newif\iffl@apsrev
\newif\iffl@fancytheorems

\DeclareOption{colorlinks}{\fl@colorlinkstrue}
\DeclareOption{apsrev}{\fl@apsrevtrue}
\DeclareOption{fancytheorems}{\fl@fancytheoremstrue}
\DeclareOption*{\PassOptionsToClass{\CurrentOption}{scrartcl}}
\ExecuteOptions{colorlinks}
\ProcessOptions\relax

\LoadClass[10pt,a4paper,oneside]{scrartcl}

\RequirePackage[a4paper,top=3cm,bottom=2cm,left=3cm,right=3cm,marginparwidth=1.75cm]{geometry}

%%% math symbols %%%
\RequirePackage{amsmath,amssymb,amsfonts,bm,esint}
\numberwithin{equation}{section}
\RequirePackage{braket}
\RequirePackage{lmodern}

%%% hyperref and url %%%
\RequirePackage[unicode]{hyperref}
\iffl@colorlinks
    \hypersetup{colorlinks=true,citecolor=blue,linkcolor=blue,urlcolor=blue}
\else
    \hypersetup{hidelinks}
\fi
\RequirePackage{cleveref}
\crefname{equation}{eqn.}{eqns.}
\Crefname{equation}{Eqn.}{Eqns.}

\RequirePackage{url}
\PassOptionsToPackage{hyphens}{url}
\def\UrlFont{\ttfamily}

\RequirePackage{etoolbox}
\AtBeginDocument{
    \hypersetup{
        pdftitle=\exercise@exercisenumber,
        pdfauthor=\exercise@coursetitle,
    }
}

\usepackage{extarrows}
\usepackage{bbm}
\usepackage{bbold}
\usepackage{dsfont}

\usepackage[makeroom]{cancel}
\newcommand{\separator}{\begin{center}$\clubsuit$~$\clubsuit$~$\clubsuit$\end{center}}
\newcommand{\acknowledgement}[1]{\separator\noindent\emph{Acknowledgement.---}  {#1}}

%%% fancyhdr %%%
\RequirePackage{datetime2}

\RequirePackage{scrlayer-scrpage}
\clearpairofpagestyles
\ihead{\exercise@number}
\ohead{\exercise@coursetitle~(\exercise@semester)}
\cfoot*{\pagemark}
\renewcommand{\headfont}{\normalfont}
\renewcommand{\pnumfont}{\normalfont}

%%% Problem Set %%%
\newcommand{\exerciseProblemName}{}%
\newcounter{exerciseProblemCounter}%

\newenvironment{problem}[1][Problem \arabic{exerciseProblemCounter}]%
{\stepcounter{exerciseProblemCounter}
    {\addcontentsline{toc}{subsection}{Problem \arabic{exerciseProblemCounter}}}%
    \renewcommand{\exerciseProblemName}{Problem \arabic{exerciseProblemCounter}: #1}%
    {\noindent \textbf{\exerciseProblemName}.}
}%

\newenvironment{problem*}[1][Problem \arabic{exerciseProblemCounter}]%
{\stepcounter{exerciseProblemCounter}
    {\addcontentsline{toc}{subsection}{Problem \arabic{exerciseProblemCounter}}}%
    \renewcommand{\exerciseProblemName}{Problem \arabic{exerciseProblemCounter}: #1}%
    {\noindent \textbf{\exerciseProblemName~(Challenge)}.}
}%

\newenvironment{solution}[1][Solution \arabic{exerciseProblemCounter}]%
{\stepcounter{exerciseProblemCounter}
    {\addcontentsline{toc}{subsection}{Solution \arabic{exerciseProblemCounter}}}%
    \renewcommand{\exerciseProblemName}{Problem \arabic{exerciseProblemCounter}: #1}%
    {\noindent \textbf{\exerciseProblemName}.}
}%

\newenvironment{solution*}[1][Solution \arabic{exerciseProblemCounter}]%
{\stepcounter{exerciseProblemCounter}
    {\addcontentsline{toc}{subsection}{Solution \arabic{exerciseProblemCounter}}}%
    \renewcommand{\exerciseProblemName}{Problem \arabic{exerciseProblemCounter}: #1}%
    {\noindent \textbf{\exerciseProblemName~(Challenge)}.}
}%

\newenvironment{answer}{%
    \leavevmode\color{blue}\ignorespaces%
}{%
}%


%%% Maketitle %%%
\newcommand{\oldmaketitle}{\maketitle}
\newcommand{\makeheader}{\maketitle}
\renewcommand{\makeheader}{
    \thispagestyle{plain}
    \newpage
    \setcounter{page}{1}
    \noindent
    \begin{center}
        \framebox[\textwidth][c]{
            \vbox{
                \makebox[0pt][l]{\quad {\exercise@coursetitle~(\exercise@semester)}}%
                \hfill
                \makebox[0pt][r]{Last updated: \today\quad} %\DTMnow

                \begin{center}
                    \ifx\exercise@exercisetitle\empty\textbf{\Large \exercise@exercisenumber}\else\textbf{\Large \exercise@exercisenumber:
                            \exercise@exercisetitle}\fi

                    Due: \exercise@exercisedue
                \end{center}

                \makebox[0pt][l]{\quad {Instructor: \exercise@instructor}}%
                \hfill
                \makebox[0pt][r]{Tutor: \exercise@tutor \quad}
            }
        }
    \end{center}
    \vspace*{1mm}
}

%%% custom information %%%
\def\exercise@coursetitle{}
\def\exercise@semester{}
\def\exercise@exercisetitle{}
\def\exercise@exercisenumber{}
\def\exercise@exercisedue{}
\newcommand{\course}[3]{%
    \def\exercise@coursetitle{#1}
    \def\exercise@semester{#2}
    \def\exercise@instructor{#3}
}
\newcommand{\exercise}[4]{%
    \def\exercise@exercisenumber{#1}
    \def\exercise@exercisetitle{#2}
    \def\exercise@exercisedue{#3}
    \def\exercise@tutor{#4}
}

%%% bibliographies %%%
\usepackage{natbib}
\iffl@apsrev
    \bibliographystyle{apsrev4-1-title}
\else
    \bibliographystyle{unsrt}
\fi

\newcommand{\subbibliography}{\bibliography}

%%% theorem styles %%%
\RequirePackage[svgnames,dvipsnames,table]{xcolor}
\RequirePackage{amsthm}
\newtheorem{theorem}{Theorem}[section]
\newtheorem{definition}[theorem]{Definition}
\newtheorem{example}[theorem]{Example}
\newtheorem{remark}[theorem]{Remark}
\newtheorem{lemma}[theorem]{Lemma}
\newtheorem{proposition}[theorem]{Proposition}
\newtheorem{corollary}[theorem]{Corollary}
\newtheorem{postulate}[theorem]{Postulate}
\newtheorem{project}{Research Project}

%%% tables %%%
\RequirePackage{booktabs,multirow,longtable,diagbox}

%%% figures %%%
\RequirePackage{graphicx,float}

%%% code listing %%%
\RequirePackage{xcolor}

%%% other commands %%%
\providecommand{\tightlist}{%
    \setlength{\itemsep}{0pt}\setlength{\parskip}{0pt}}

%%% pages %%%