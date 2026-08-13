import swaggerUi from 'swagger-ui-express';

const customDarkCss = `
  /* Tema Oscuro Premium para Swagger UI */
  body {
    background-color: #0b0f19;
    color: #f3f4f6;
    margin: 0;
    font-family: 'Inter', -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  }
  .swagger-ui {
    background-color: #0b0f19;
    color: #e5e7eb;
  }
  .swagger-ui .info .title, .swagger-ui .info h1, .swagger-ui .info h2, .swagger-ui .info h3, .swagger-ui .info h4, .swagger-ui .info h5 {
    color: #ffffff;
    font-weight: 700;
  }
  .swagger-ui .info li, .swagger-ui .info p, .swagger-ui .info table, .swagger-ui .info a {
    color: #9ca3af;
    font-size: 14px;
  }
  .swagger-ui .info a:hover {
    color: #3b82f6;
  }
  .swagger-ui .scheme-container {
    background-color: #111827;
    box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06);
    border-bottom: 1px solid #1f2937;
    padding: 20px 0;
  }
  .swagger-ui select {
    background-color: #1f2937;
    color: #f3f4f6;
    border: 1px solid #374151;
    border-radius: 6px;
    padding: 6px 10px;
  }
  .swagger-ui .opblock-tag {
    color: #ffffff;
    border-bottom: 1px solid #1f2937;
    font-weight: 600;
  }
  .swagger-ui .opblock-tag small {
    color: #9ca3af;
  }
  .swagger-ui .opblock {
    border-radius: 8px;
    box-shadow: 0 2px 4px rgba(0,0,0,0.1);
  }
  .swagger-ui .opblock .opblock-summary-path {
    color: #f3f4f6;
    font-family: monospace;
    font-size: 15px;
  }
  .swagger-ui .opblock .opblock-summary-description {
    color: #9ca3af;
  }
  .swagger-ui .opblock.opblock-get {
    background: rgba(59, 130, 246, 0.08);
    border-color: #3b82f6;
  }
  .swagger-ui .opblock.opblock-get .opblock-summary-method {
    background: #3b82f6;
    border-radius: 4px;
    font-weight: bold;
  }
  .swagger-ui .opblock.opblock-post {
    background: rgba(16, 185, 129, 0.08);
    border-color: #10b981;
  }
  .swagger-ui .opblock.opblock-post .opblock-summary-method {
    background: #10b981;
    border-radius: 4px;
    font-weight: bold;
  }
  .swagger-ui .opblock.opblock-put {
    background: rgba(245, 158, 11, 0.08);
    border-color: #f59e0b;
  }
  .swagger-ui .opblock.opblock-put .opblock-summary-method {
    background: #f59e0b;
    border-radius: 4px;
    font-weight: bold;
  }
  .swagger-ui .opblock.opblock-delete {
    background: rgba(239, 68, 68, 0.08);
    border-color: #ef4444;
  }
  .swagger-ui .opblock.opblock-delete .opblock-summary-method {
    background: #ef4444;
    border-radius: 4px;
    font-weight: bold;
  }
  .swagger-ui .opblock .opblock-section-header {
    background: #1f2937;
    color: #f3f4f6;
    border-bottom: 1px solid #374151;
  }
  .swagger-ui .opblock .opblock-section-header h4 {
    color: #ffffff;
  }
  .swagger-ui .tabli button {
    color: #9ca3af;
  }
  .swagger-ui .tabli.active button {
    color: #3b82f6;
    font-weight: bold;
  }
  .swagger-ui .response-col_status {
    color: #ffffff;
    font-weight: 600;
  }
  .swagger-ui table thead tr td, .swagger-ui table thead tr th {
    color: #9ca3af;
    border-bottom: 1px solid #1f2937;
  }
  .swagger-ui .dialog-ux .modal-ux {
    background-color: #111827;
    border: 1px solid #374151;
    border-radius: 12px;
  }
  .swagger-ui .dialog-ux .modal-ux-header h3 {
    color: #ffffff;
  }
  .swagger-ui .dialog-ux .modal-ux-content {
    color: #e5e7eb;
  }
  .swagger-ui .btn {
    background-color: #1f2937;
    color: #f3f4f6;
    border: 1px solid #374151;
    border-radius: 6px;
    transition: background-color 0.2s;
  }
  .swagger-ui .btn:hover {
    background-color: #374151;
  }
  .swagger-ui .btn.execute {
    background-color: #3b82f6;
    color: #ffffff;
    border-color: #3b82f6;
  }
  .swagger-ui .btn.execute:hover {
    background-color: #2563eb;
  }
  .swagger-ui .model-box {
    background: #111827;
    border-radius: 6px;
    padding: 10px;
    border: 1px solid #1f2937;
  }
  .swagger-ui .model {
    color: #e5e7eb;
  }
  .swagger-ui .prop-type {
    color: #60a5fa;
  }
  .swagger-ui .prop-format {
    color: #9ca3af;
  }
  .swagger-ui .model-title {
    color: #ffffff;
    font-weight: 600;
  }
  .swagger-ui .servers-title {
    color: #ffffff;
  }
  .swagger-ui .parameter__name {
    color: #ffffff;
    font-weight: 600;
  }
  .swagger-ui .parameter__type {
    color: #60a5fa;
  }
  .swagger-ui .parameter__in {
    color: #9ca3af;
    font-style: italic;
  }
  .swagger-ui input[type=text], .swagger-ui textarea {
    background: #1f2937;
    color: #ffffff;
    border: 1px solid #374151;
    border-radius: 4px;
    padding: 6px 10px;
  }
  .swagger-ui input[type=text]:focus, .swagger-ui textarea:focus {
    border-color: #3b82f6;
    outline: none;
  }
  .swagger-ui .response-col_description__inner div.markdown p {
    color: #e5e7eb;
  }
  .swagger-ui .response-col_description__inner div.markdown code {
    background-color: #1f2937;
    color: #fb7185;
    padding: 2px 4px;
    border-radius: 4px;
  }
`;

export const openApiSpec = {
  openapi: "3.0.0",
  info: {
    title: "WhatsApp Web Sync Service API",
    version: "1.0.0",
    description: "Microservicio Node.js que sincroniza mensajes de WhatsApp Web con el AI-CRM usando Baileys. Permite gestionar múltiples sesiones, enviar QR y mensajes individuales o masivos.",
    contact: {
      name: "Soporte de Desarrollo - W3B Innovation",
    }
  },
  servers: [
    {
      url: "http://localhost:4000",
      description: "Servidor Local"
    }
  ],
  tags: [
    {
      name: "Sesiones",
      description: "Gestión y conexión de cuentas de WhatsApp"
    },
    {
      name: "Mensajería",
      description: "Envío de mensajes individuales y campañas masivas"
    },
    {
      name: "Grupos",
      description: "Operaciones relacionadas con grupos de WhatsApp"
    },
    {
      name: "Sistema & Monitoreo",
      description: "Métricas del sistema, estados y simulación de fallos"
    }
  ],
  paths: {
    "/sessions": {
      get: {
        tags: ["Sesiones"],
        summary: "Listar todas las sesiones",
        description: "Obtiene una lista de todas las sesiones de WhatsApp configuradas en el microservicio y su estado actual.",
        responses: {
          200: {
            description: "Lista de sesiones obtenida con éxito.",
            content: {
              "application/json": {
                schema: {
                  type: "array",
                  items: {
                    $ref: "#/components/schemas/SessionInfo"
                  }
                }
              }
            }
          }
        }
      }
    },
    "/status": {
      get: {
        tags: ["Sesiones"],
        summary: "Ver estado de una cuenta",
        description: "Obtiene el estado de conexión, códigos de vinculación, QR actual e información de la cuenta especificada.",
        parameters: [
          {
            name: "accountId",
            in: "query",
            description: "ID de la cuenta a consultar",
            required: false,
            schema: {
              type: "string",
              default: "account-1"
            }
          }
        ],
        responses: {
          200: {
            description: "Estado de la cuenta obtenido con éxito.",
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/SessionDetail"
                }
              }
            }
          }
        }
      }
    },
    "/connect": {
      post: {
        tags: ["Sesiones"],
        summary: "Conectar una cuenta",
        description: "Inicia el proceso de conexión de WhatsApp para una cuenta específica. Si el estado es 'open', no realiza cambios.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  accountId: {
                    type: "string",
                    description: "ID de la cuenta",
                    default: "account-1"
                  },
                  companyId: {
                    type: "string",
                    description: "ID de la empresa asociada"
                  },
                  browserName: {
                    type: "string",
                    description: "Nombre del dispositivo que aparecerá en WhatsApp"
                  },
                  phoneNumber: {
                    type: "string",
                    description: "Número de teléfono en formato internacional para vinculación por código (opcional)"
                  }
                }
              }
            }
          }
        },
        responses: {
          200: {
            description: "Inicio del proceso de conexión exitoso o cuenta ya conectada.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    message: { type: "string" },
                    status: { type: "string" }
                  }
                }
              }
            }
          }
        }
      }
    },
    "/logout": {
      post: {
        tags: ["Sesiones"],
        summary: "Cerrar sesión / Cancelar vinculación",
        description: "Desconecta WhatsApp de la cuenta indicada y elimina las credenciales locales de la sesión.",
        requestBody: {
          required: false,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  accountId: {
                    type: "string",
                    description: "ID de la cuenta a cerrar sesión",
                    default: "account-1"
                  }
                }
              }
            }
          }
        },
        responses: {
          200: {
            description: "Sesión cerrada correctamente.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    success: { type: "boolean" },
                    message: { type: "string" }
                  }
                }
              }
            }
          },
          500: {
            description: "Error al cerrar sesión.",
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse"
                }
              }
            }
          }
        }
      }
    },
    "/update-config": {
      post: {
        tags: ["Sesiones"],
        summary: "Actualizar configuración de sesión",
        description: "Actualiza los metadatos de configuración (empresa, origen, grupo activo) asociados a una cuenta de WhatsApp activa.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["accountId"],
                properties: {
                  accountId: { type: "string", description: "ID de la cuenta" },
                  companyId: { type: "string", description: "ID de la empresa" },
                  origin: { type: "string", description: "Origen / URL de la integración" },
                  activeGroupId: { type: "string", description: "ID del grupo activo de WhatsApp" },
                  activeGroupName: { type: "string", description: "Nombre del grupo activo de WhatsApp" }
                }
              }
            }
          }
        },
        responses: {
          200: {
            description: "Configuración actualizada con éxito.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    success: { type: "boolean" },
                    message: { type: "string" }
                  }
                }
              }
            }
          },
          400: {
            description: "Falta el parámetro accountId.",
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse"
                }
              }
            }
          },
          404: {
            description: "Sesión no encontrada.",
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse"
                }
              }
            }
          }
        }
      }
    },
    "/send-message": {
      post: {
        tags: ["Mensajería"],
        summary: "Enviar un mensaje individual",
        description: "Envía un mensaje de texto o multimedia (imagen/video) a un número de teléfono específico desde una de las sesiones activas.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["number"],
                properties: {
                  accountId: {
                    type: "string",
                    description: "ID de la cuenta remitente",
                    default: "account-1"
                  },
                  number: {
                    type: "string",
                    description: "Número de teléfono destino en formato internacional (e.g. 521XXXXXXXXXX)"
                  },
                  message: {
                    type: "string",
                    description: "Mensaje de texto. Opcional si se envía multimedia con caption."
                  },
                  media: {
                    type: "object",
                    description: "Detalles del archivo multimedia a enviar",
                    properties: {
                      url: {
                        type: "string",
                        description: "URL pública del archivo multimedia"
                      },
                      type: {
                        type: "string",
                        description: "Tipo de archivo",
                        enum: ["image", "video"]
                      }
                    }
                  }
                }
              }
            }
          }
        },
        responses: {
          200: {
            description: "Mensaje enviado exitosamente.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    success: { type: "boolean" },
                    result: { type: "object" }
                  }
                }
              }
            }
          },
          400: {
            description: "Faltan parámetros obligatorios.",
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse"
                }
              }
            }
          },
          503: {
            description: "La cuenta de WhatsApp no está conectada.",
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse"
                }
              }
            }
          },
          500: {
            description: "Error al procesar el envío del mensaje.",
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse"
                }
              }
            }
          }
        }
      }
    },
    "/bulk-send": {
      post: {
        tags: ["Mensajería"],
        summary: "Iniciar envío masivo (segundo plano)",
        description: "Inicia una campaña masiva de envío de mensajes con spintax, drip-feeding (goteo espaciado) y variables dinámicas en segundo plano.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["accountId", "message", "contacts", "bulkMessageId"],
                properties: {
                  accountId: { type: "string", description: "ID de la cuenta remitente" },
                  companyId: { type: "string", description: "ID de la empresa" },
                  message: { type: "string", description: "Mensaje plantilla. Soporta {{nombre}}, {{name}} y Spintax (e.g. {Hola|Buen día})" },
                  contacts: {
                    type: "array",
                    description: "Lista de contactos a enviar",
                    items: {
                      type: "object",
                      required: ["phoneNumber"],
                      properties: {
                        name: { type: "string" },
                        phoneNumber: { type: "string" }
                      }
                    }
                  },
                  bulkMessageId: { type: "string", description: "ID único de la campaña de envío masivo" },
                  customTemplate: {
                    type: "object",
                    properties: {
                      media: {
                        type: "object",
                        properties: {
                          url: { type: "string" },
                          type: { type: "string", enum: ["image", "video"] }
                        }
                      }
                    }
                  },
                  webhookUrl: { type: "string", description: "URL del Webhook al cual notificar el progreso y estado final" }
                }
              }
            }
          }
        },
        responses: {
          200: {
            description: "Campaña masiva iniciada.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    success: { type: "boolean" },
                    message: { type: "string" },
                    bulkMessageId: { type: "string" }
                  }
                }
              }
            }
          },
          400: {
            description: "Parámetros insuficientes.",
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse"
                }
              }
            }
          }
        }
      }
    },
    "/bulk-send/pause": {
      post: {
        tags: ["Mensajería"],
        summary: "Pausar envío masivo",
        description: "Pausa temporalmente una campaña masiva de envío en curso basada en su ID.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["bulkMessageId"],
                properties: {
                  bulkMessageId: { type: "string", description: "ID de la campaña" }
                }
              }
            }
          }
        },
        responses: {
          200: {
            description: "Pausa solicitada con éxito.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    success: { type: "boolean" },
                    message: { type: "string" }
                  }
                }
              }
            }
          },
          400: {
            description: "Falta el ID de la campaña.",
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse"
                }
              }
            }
          },
          404: {
            description: "La campaña no se encuentra activa en el microservicio.",
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse"
                }
              }
            }
          }
        }
      }
    },
    "/bulk-send/cancel": {
      post: {
        tags: ["Mensajería"],
        summary: "Cancelar envío masivo",
        description: "Cancela permanentemente una campaña masiva de envío en curso basada en su ID.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["bulkMessageId"],
                properties: {
                  bulkMessageId: { type: "string", description: "ID de la campaña" }
                }
              }
            }
          }
        },
        responses: {
          200: {
            description: "Cancelación solicitada con éxito.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    success: { type: "boolean" },
                    message: { type: "string" }
                  }
                }
              }
            }
          },
          400: {
            description: "Falta el ID de la campaña.",
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse"
                }
              }
            }
          },
          404: {
            description: "La campaña no se encuentra activa en el microservicio.",
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse"
                }
              }
            }
          }
        }
      }
    },
    "/groups": {
      get: {
        tags: ["Grupos"],
        summary: "Obtener lista de grupos",
        description: "Devuelve los metadatos de todos los grupos de WhatsApp asociados a la cuenta especificada.",
        parameters: [
          {
            name: "accountId",
            in: "query",
            description: "ID de la cuenta",
            required: false,
            schema: {
              type: "string",
              default: "account-1"
            }
          }
        ],
        responses: {
          200: {
            description: "Lista de grupos obtenida exitosamente.",
            content: {
              "application/json": {
                schema: {
                  type: "array",
                  items: {
                    type: "object"
                  }
                }
              }
            }
          },
          503: {
            description: "WhatsApp no está conectado.",
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse"
                }
              }
            }
          },
          500: {
            description: "Error al recuperar los grupos.",
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse"
                }
              }
            }
          }
        }
      }
    },
    "/group-invite": {
      get: {
        tags: ["Grupos"],
        summary: "Obtener link de invitación de grupo",
        description: "Obtiene el enlace URL oficial para invitar a usuarios al grupo de WhatsApp especificado.",
        parameters: [
          {
            name: "accountId",
            in: "query",
            description: "ID de la cuenta",
            required: false,
            schema: {
              type: "string",
              default: "account-1"
            }
          },
          {
            name: "groupId",
            in: "query",
            description: "JID del grupo a consultar (e.g. 120363028394829304@g.us)",
            required: true,
            schema: {
              type: "string"
            }
          }
        ],
        responses: {
          200: {
            description: "Enlace obtenido con éxito.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    link: { type: "string" }
                  }
                }
              }
            }
          },
          400: {
            description: "El parámetro groupId es requerido.",
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse"
                }
              }
            }
          },
          500: {
            description: "Error al obtener el enlace.",
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse"
                }
              }
            }
          }
        }
      }
    },
    "/resolve-group": {
      get: {
        tags: ["Grupos"],
        summary: "Resolver información del grupo por enlace",
        description: "Resuelve los detalles del grupo de WhatsApp (como nombre, foto y metadatos) utilizando su enlace de invitación.",
        parameters: [
          {
            name: "accountId",
            in: "query",
            description: "ID de la cuenta",
            required: false,
            schema: {
              type: "string",
              default: "account-1"
            }
          },
          {
            name: "url",
            in: "query",
            description: "Enlace URL completo del grupo",
            required: true,
            schema: {
              type: "string"
            }
          }
        ],
        responses: {
          200: {
            description: "Información del grupo resuelta.",
            content: {
              "application/json": {
                schema: {
                  type: "object"
                }
              }
            }
          },
          400: {
            description: "El parámetro url es requerido.",
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse"
                }
              }
            }
          },
          500: {
            description: "Error al resolver la información del grupo.",
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse"
                }
              }
            }
          }
        }
      }
    },
    "/stats": {
      get: {
        tags: ["Sistema & Monitoreo"],
        summary: "Estadísticas globales de uso y recursos",
        description: "Obtiene métricas operativas generales o filtradas por empresa (mensajes enviados, recibidos, aciertos y fallas del webhook) junto con el uso de memoria RAM del proceso Node.js.",
        parameters: [
          {
            name: "companyId",
            in: "query",
            description: "Filtrar estadísticas para una empresa específica",
            required: false,
            schema: {
              type: "string"
            }
          }
        ],
        responses: {
          200: {
            description: "Métricas obtenidas con éxito.",
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/GlobalStats"
                }
              }
            }
          }
        }
      }
    },
    "/test-disconnect": {
      post: {
        tags: ["Sistema & Monitoreo"],
        summary: "Simular desconexión de WebSocket [SOLO PRUEBAS]",
        description: "Fuerza el cierre del WebSocket de una cuenta activa para simular un código de error de red (e.g. 428) y validar la lógica de reconexión automática.",
        requestBody: {
          required: false,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  accountId: {
                    type: "string",
                    description: "ID de la cuenta a desconectar",
                    default: "account-1"
                  }
                }
              }
            }
          }
        },
        responses: {
          200: {
            description: "WebSocket desconectado para simulación.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    success: { type: "boolean" },
                    message: { type: "string" }
                  }
                }
              }
            }
          },
          404: {
            description: "No existe socket activo para la cuenta.",
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse"
                }
              }
            }
          },
          500: {
            description: "Error durante la simulación de desconexión.",
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse"
                }
              }
            }
          }
        }
      }
    }
  },
  components: {
    schemas: {
      SessionInfo: {
        type: "object",
        properties: {
          id: { type: "string" },
          status: { type: "string" },
          hasQr: { type: "boolean" },
          number: { type: "string", nullable: true },
          origin: { type: "string", nullable: true },
          companyId: { type: "string", nullable: true },
          activeGroupId: { type: "string", nullable: true },
          activeGroupName: { type: "string", nullable: true }
        }
      },
      SessionDetail: {
        type: "object",
        properties: {
          accountId: { type: "string" },
          status: { type: "string" },
          qr: { type: "string", nullable: true },
          pairingCode: { type: "string", nullable: true },
          number: { type: "string", nullable: true },
          origin: { type: "string", nullable: true },
          companyId: { type: "string", nullable: true },
          activeGroupId: { type: "string", nullable: true },
          activeGroupName: { type: "string", nullable: true },
          duplicateConflictId: { type: "string", nullable: true },
          duplicateConflictOrigin: { type: "string", nullable: true }
        }
      },
      GlobalStats: {
        type: "object",
        properties: {
          messagesReceived: { type: "integer" },
          messagesSent: { type: "integer" },
          webhookSuccess: { type: "integer" },
          webhookErrors: { type: "integer" },
          startTime: { type: "integer" },
          activeSessions: { type: "integer" },
          totalSessions: { type: "integer" },
          memory: {
            type: "object",
            properties: {
              rss: { type: "string" },
              heapTotal: { type: "string" },
              heapUsed: { type: "string" },
              external: { type: "string" }
            }
          },
          uptime_seconds: { type: "integer" }
        }
      },
      ErrorResponse: {
        type: "object",
        properties: {
          error: { type: "string" }
        }
      }
    }
  }
};

export function setupSwagger(app) {
  const options = {
    customCss: customDarkCss,
    customSiteTitle: "API WhatsApp Web Sync - Swagger"
  };
  
  app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(openApiSpec, options));
  console.log('[Swagger] Documentación interactiva montada en /api-docs');
}
