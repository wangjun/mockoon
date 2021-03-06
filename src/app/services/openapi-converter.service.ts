import { Injectable } from '@angular/core';
import * as SwaggerParser from '@apidevtools/swagger-parser';
import { OpenAPIV2, OpenAPIV3 } from 'openapi-types';
import { Logger } from 'src/app/classes/logger';
import { Errors } from 'src/app/enums/errors.enum';
import {
  GetRouteResponseContentType,
  RemoveLeadingSlash
} from 'src/app/libs/utils.lib';
import { SchemasBuilderService } from 'src/app/services/schemas-builder.service';
import { ToastsService } from 'src/app/services/toasts.service';
import { Environment } from 'src/app/types/environment.type';
import {
  Header,
  Method,
  methods,
  Route,
  RouteResponse,
  statusCodes
} from 'src/app/types/route.type';
import { parse as urlParse } from 'url';

type ParametersTypes = 'PATH_PARAMETERS' | 'SERVER_VARIABLES';
type SpecificationVersions = 'SWAGGER' | 'OPENAPI_V3';

/**
 * Convert to and from Swagger/OpenAPI formats
 *
 * OpenAPI specifications: https://github.com/OAI/OpenAPI-Specification/blob/master/versions/3.0.1.md
 * Swagger specifications: https://github.com/OAI/OpenAPI-Specification/blob/master/versions/2.0.md
 */
@Injectable({ providedIn: 'root' })
export class OpenAPIConverterService {
  private logger = new Logger('[SERVICE][OPENAPI-CONVERTER]');

  constructor(
    private schemasBuilderService: SchemasBuilderService,
    private toastsService: ToastsService
  ) {}

  /**
   * Import Swagger or OpenAPI format
   *
   * @param filePath
   */
  public async import(filePath: string) {
    this.logger.info(`Starting OpenAPI file '${filePath}' import`);

    try {
      const parsedAPI:
        | OpenAPIV2.Document
        | OpenAPIV3.Document = await SwaggerParser.dereference(filePath);

      if (this.isSwagger(parsedAPI)) {
        return this.convertFromSwagger(parsedAPI);
      } else if (this.isOpenAPIV3(parsedAPI)) {
        return this.convertFromOpenAPIV3(parsedAPI);
      } else {
        this.toastsService.addToast('warning', Errors.IMPORT_WRONG_VERSION);
      }
    } catch (error) {
      this.toastsService.addToast(
        'error',
        `${Errors.IMPORT_ERROR}: ${error.message}`
      );
      this.logger.error(`Error while importing OpenAPI file: ${error.message}`);
    }
  }

  /**
   * Export to OpenAPI format
   *
   * @param environment
   */
  public export(environment: Environment): string {
    this.logger.info(
      `Starting environment ${environment.uuid} export to OpenAPI file`
    );

    try {
      return this.convertToOpenAPIV3(environment);
    } catch (error) {
      this.toastsService.addToast(
        'error',
        `${Errors.EXPORT_ERROR}: ${error.message}`
      );
      this.logger.error(`Error while exporting OpenAPI file: ${error.message}`);
    }
  }

  /**
   * Convert Swagger 2.0 format
   *
   * @param parsedAPI
   */
  private convertFromSwagger(parsedAPI: OpenAPIV2.Document): Environment {
    const newEnvironment = this.schemasBuilderService.buildEnvironment(
      false,
      false
    );

    // parse the port
    newEnvironment.port = parsedAPI.host &&
      parseInt(parsedAPI.host.split(':')[1], 10) || newEnvironment.port;

    if (parsedAPI.basePath) {
      newEnvironment.endpointPrefix = RemoveLeadingSlash(parsedAPI.basePath);
    }

    newEnvironment.name = parsedAPI.info.title || 'Swagger import';

    newEnvironment.routes = this.createRoutes(parsedAPI, 'SWAGGER');

    return newEnvironment;
  }

  /**
   * Convert OpenAPI 3.0 format
   *
   * @param parsedAPI
   */
  private convertFromOpenAPIV3(parsedAPI: OpenAPIV3.Document): Environment {
    const newEnvironment = this.schemasBuilderService.buildEnvironment(
      false,
      false
    );

    const server: OpenAPIV3.ServerObject[] = parsedAPI.servers;

    newEnvironment.endpointPrefix =
      server &&
      server[0] &&
      server[0].url &&
      RemoveLeadingSlash(
        urlParse(
          this.parametersReplace(
            server[0].url,
            'SERVER_VARIABLES',
            server[0].variables
          )
        ).path
      );

    newEnvironment.name = parsedAPI.info.title || 'OpenAPI import';

    newEnvironment.routes = this.createRoutes(parsedAPI, 'OPENAPI_V3');

    return newEnvironment;
  }

  /**
   * Convert environment to OpenAPI JSON object
   *
   * @param environment
   */
  private convertToOpenAPIV3(environment: Environment) {
    const openAPIEnvironment: OpenAPIV3.Document = {
      openapi: '3.0.0',
      info: { title: environment.name, version: '1.0.0' },
      servers: [
        {
          url: `${environment.https ? 'https' : 'http'}://localhost:${
            environment.port
          }/${environment.endpointPrefix}`
        }
      ],
      paths: environment.routes.reduce<OpenAPIV3.PathsObject>(
        (paths, route) => {
          const pathParamaters = route.endpoint.match(/:[a-zA-Z0-9_]+/g);
          let endpoint = '/' + route.endpoint;

          if (pathParamaters && pathParamaters.length > 0) {
            endpoint =
              '/' + route.endpoint.replace(/:([a-zA-Z0-9_]+)/g, '{$1}');
          }

          if (!paths[endpoint]) {
            paths[endpoint] = {};
          }

          paths[endpoint][route.method] = {
            description: route.documentation,
            responses: route.responses.reduce<OpenAPIV3.ResponsesObject>(
              (responses, routeResponse) => {
                const responseContentType = GetRouteResponseContentType(
                  environment,
                  routeResponse
                );

                responses[routeResponse.statusCode.toString()] = {
                  description: routeResponse.label,
                  content: responseContentType
                    ? { [responseContentType]: {} }
                    : {},
                  headers: [
                    ...environment.headers,
                    ...routeResponse.headers
                  ].reduce<{
                    [header: string]: OpenAPIV3.HeaderObject;
                  }>((headers, header) => {
                    if (header.key.toLowerCase() !== 'content-type') {
                      headers[header.key] = {
                        schema: { type: 'string' },
                        example: header.value
                      };
                    }

                    return headers;
                  }, {})
                };

                return responses;
              },
              {}
            )
          };

          if (pathParamaters && pathParamaters.length > 0) {
            paths[endpoint][route.method].parameters = pathParamaters.reduce<
              OpenAPIV3.ParameterObject[]
            >((parameters, parameter) => {
              parameters.push({
                name: parameter.slice(1, parameter.length),
                in: 'path',
                schema: { type: 'string' },
                required: true
              });

              return parameters;
            }, []);
          }

          return paths;
        },
        {}
      )
    };

    try {
      SwaggerParser.validate(openAPIEnvironment);
    } catch (error) {
      this.logger.error(
        `Error while validating OpenAPI export object: ${error.message}`
      );
    }

    return JSON.stringify(openAPIEnvironment);
  }

  /**
   * Creates routes from imported swagger/OpenAPI document
   *
   * @param parsedAPI
   * @param version
   */
  private createRoutes(
    parsedAPI: OpenAPIV2.Document,
    version: 'SWAGGER'
  ): Route[];
  private createRoutes(
    parsedAPI: OpenAPIV3.Document,
    version: 'OPENAPI_V3'
  ): Route[];
  private createRoutes(
    parsedAPI: OpenAPIV2.Document | OpenAPIV3.Document,
    version: SpecificationVersions
  ): Route[] {
    const routes: Route[] = [];

    Object.keys(parsedAPI.paths).forEach((routePath) => {
      Object.keys(parsedAPI.paths[routePath]).forEach((routeMethod) => {
        const parsedRoute:
          | OpenAPIV2.OperationObject
          | OpenAPIV3.OperationObject = parsedAPI.paths[routePath][routeMethod];

        if (methods.includes(routeMethod)) {
          const routeResponses: RouteResponse[] = [];

          Object.keys(parsedRoute.responses).forEach((responseStatus) => {
            // filter unsupported status codes (i.e. ranges containing "X", 4XX, 5XX, etc)
            if (
              statusCodes.find(
                (statusCode) => statusCode.code === parseInt(responseStatus, 10)
              )
            ) {
              const routeResponse:
                | OpenAPIV2.ResponseObject
                | OpenAPIV3.ResponseObject =
                parsedRoute.responses[responseStatus];

              let contentTypeHeaders;
              if (version === 'SWAGGER') {
                contentTypeHeaders = (parsedRoute as OpenAPIV2.OperationObject)
                  .produces;
              } else if (version === 'OPENAPI_V3') {
                contentTypeHeaders = (routeResponse as OpenAPIV3.ResponseObject)
                  .content
                  ? Object.keys(
                      (routeResponse as OpenAPIV3.ResponseObject).content
                    )
                  : [];
              }

              routeResponses.push({
                ...this.schemasBuilderService.buildRouteResponse(),
                body: '',
                statusCode: parseInt(responseStatus, 10),
                label: routeResponse.description || '',
                headers: this.buildResponseHeaders(
                  contentTypeHeaders,
                  routeResponse.headers
                )
              });
            }
          });

          // check if has at least one response
          if (!routeResponses.length) {
            routeResponses.push({
              ...this.schemasBuilderService.buildRouteResponse(),
              headers: [
                this.schemasBuilderService.buildHeader(
                  'Content-Type',
                  'application/json'
                )
              ]
            });
          }

          const newRoute: Route = {
            ...this.schemasBuilderService.buildRoute(false),
            documentation: parsedRoute.summary || parsedRoute.description || '',
            method: routeMethod as Method,
            endpoint: RemoveLeadingSlash(
              this.parametersReplace(routePath, 'PATH_PARAMETERS')
            ),
            responses: routeResponses
          };

          routes.push(newRoute);
        }
      });
    });

    return routes;
  }

  /**
   * Build route response headers from 'content' (v3) or 'produces' (v2), and 'headers' objects
   *
   * @param contentTypes
   * @param responseHeaders
   */
  private buildResponseHeaders(
    contentTypes: string[],
    responseHeaders:
      | OpenAPIV2.HeadersObject
      | {
          [key: string]: OpenAPIV3.ReferenceObject | OpenAPIV3.HeaderObject;
        }
  ): Header[] {
    const routeContentTypeHeader = this.schemasBuilderService.buildHeader(
      'Content-Type',
      'application/json'
    );

    if (
      contentTypes &&
      contentTypes.length &&
      !contentTypes.includes('application/json')
    ) {
      routeContentTypeHeader.value = contentTypes[0];
    }

    if (responseHeaders) {
      return [
        routeContentTypeHeader,
        ...Object.keys(responseHeaders).map((header) =>
          this.schemasBuilderService.buildHeader(header, '')
        )
      ];
    }

    return [routeContentTypeHeader];
  }

  /**
   * Replace parameters in `str`
   *
   * @param str
   * @param parametersType
   * @param parameters
   */
  private parametersReplace<T extends ParametersTypes>(
    str: string,
    parametersType: T,
    parameters?: T extends 'PATH_PARAMETERS'
      ? never
      : { [variable in string]: OpenAPIV3.ServerVariableObject }
  ) {
    return str.replace(/{(\w+)}/gi, (searchValue, replaceValue) => {
      if (parametersType === 'PATH_PARAMETERS') {
        return ':' + replaceValue;
      } else if (parametersType === 'SERVER_VARIABLES') {
        return parameters[replaceValue].default;
      }
    });
  }

  /**
   * Swagger specification type guard
   *
   * @param parsedAPI
   */
  private isSwagger(parsedAPI: any): parsedAPI is OpenAPIV2.Document {
    return parsedAPI.swagger !== undefined;
  }

  /**
   * OpenAPI v3 specification type guard
   * @param parsedAPI
   */
  private isOpenAPIV3(parsedAPI: any): parsedAPI is OpenAPIV3.Document {
    return (
      parsedAPI.openapi !== undefined && parsedAPI.openapi.startsWith('3.')
    );
  }
}
