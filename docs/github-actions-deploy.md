# Despliegue Automatico Con GitHub Actions

Este proyecto incluye el workflow `.github/workflows/deploy-develop.yml`.

El despliegue se ejecuta cuando hay un push a la rama `develop` o cuando se lanza manualmente desde la pestana **Actions** en GitHub.

## Que Hace El Workflow

1. Descarga el codigo del repositorio.
2. Configura Node.js 20.
3. Valida la sintaxis del backend con `npm --prefix backend run check`.
4. Se autentica contra AWS usando OIDC.
5. Empaqueta `backend/lambda.mjs`.
6. Actualiza la Lambda `fotostock-api`.
7. Actualiza variables de entorno de Lambda desde GitHub Secrets.
8. Sube `index.html`, `styles.css`, `app.js` y `config.js` al bucket S3 del frontend.
9. Invalida la cache de CloudFront.

## Secrets Necesarios En GitHub

En GitHub:

`Settings > Secrets and variables > Actions > New repository secret`

Crear estos secrets:

```text
AWS_ROLE_TO_ASSUME
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
JWT_SECRET
CORS_ORIGIN
```

`CORS_ORIGIN` puede ser `*` para el proyecto academico o la URL de CloudFront si se quiere restringir mas.

## IAM Role Recomendado

El secret `AWS_ROLE_TO_ASSUME` debe contener el ARN de un rol IAM que GitHub pueda asumir por OIDC.

Ejemplo:

```text
arn:aws:iam::954377119221:role/fotostock-github-actions-deploy-role
```

## Permisos Minimos Del Rol

El rol necesita permisos para:

- Actualizar la Lambda `fotostock-api`.
- Subir archivos al bucket `fotostock-frontend-954377119221`.
- Crear invalidaciones en CloudFront.

Politica recomendada:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "lambda:GetFunction",
        "lambda:GetFunctionConfiguration",
        "lambda:UpdateFunctionCode",
        "lambda:UpdateFunctionConfiguration"
      ],
      "Resource": "arn:aws:lambda:us-east-1:954377119221:function:fotostock-api"
    },
    {
      "Effect": "Allow",
      "Action": [
        "s3:PutObject"
      ],
      "Resource": "arn:aws:s3:::fotostock-frontend-954377119221/*"
    },
    {
      "Effect": "Allow",
      "Action": [
        "cloudfront:CreateInvalidation"
      ],
      "Resource": "arn:aws:cloudfront::954377119221:distribution/E1KBW0LU5KVXYW"
    }
  ]
}
```

## Trust Policy Del Rol

El rol debe confiar en GitHub Actions para este repositorio y la rama `develop`.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Federated": "arn:aws:iam::954377119221:oidc-provider/token.actions.githubusercontent.com"
      },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
          "token.actions.githubusercontent.com:sub": "repo:Quirama1108/FotoStock:ref:refs/heads/develop"
        }
      }
    }
  ]
}
```

## Notas

- Este workflow no crea infraestructura desde cero; actualiza recursos que ya existen.
- No sube `evidencias/` ni archivos `.docx`.
- El despliegue productivo recomendado sigue siendo la URL de CloudFront: `https://dyba4pp9u9eet.cloudfront.net`.
