# Dockerfile per il servizio DSS (Tomcat + webapp DSS demo).
#
# Strategia: si parte dall'immagine ufficiale Tomcat 11.0.18 con Temurin 21
# (Tomcat 11 richiede Java 17+; usiamo 21 LTS per stare tranquilli).
# Si copia SOLO il ROOT.war del bundle EU che gia' usi in locale.
# Il COPY esplicito del singolo file evita ambiguita' col .dockerignore.

FROM tomcat:11.0.18-jdk21-temurin

# curl serve per l'healthcheck definito in docker-compose
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl \
 && rm -rf /var/lib/apt/lists/*

# Tomcat ufficiale ha gia' webapps/ vuota, ma per sicurezza puliamo
RUN rm -rf /usr/local/tomcat/webapps/*

# Copia ESPLICITA del solo .war del DSS bundle.
# In DSS 6.4 esiste un unico ROOT.war (~530 MB) che contiene sia la UI demo
# (servita su /) sia le REST API (servite su /services/rest/...).
# Tomcat lo esplodera' in /usr/local/tomcat/webapps/ROOT/ al primo avvio.
COPY dss-demo-bundle-6.4/apache-tomcat-11.0.18/webapps/ROOT.war /usr/local/tomcat/webapps/ROOT.war

# --- OPZIONALI ---------------------------------------------------------------
# Decommenta SOLO se nel tuo bundle hai modificato questi file.
#
# Config Tomcat custom (server.xml, web.xml, context.xml, tomcat-users.xml...):
# COPY dss-demo-bundle-6.4/apache-tomcat-11.0.18/conf/ /usr/local/tomcat/conf/
#
# JAR extra messi a mano in lib/ (driver, provider crypto):
# COPY dss-demo-bundle-6.4/apache-tomcat-11.0.18/lib/ /usr/local/tomcat/lib/
#
# setenv per JAVA_OPTS custom (sovrascriverebbe CATALINA_OPTS qui sotto):
# COPY dss-demo-bundle-6.4/apache-tomcat-11.0.18/bin/setenv.sh /usr/local/tomcat/bin/setenv.sh
# RUN chmod +x /usr/local/tomcat/bin/setenv.sh
# -----------------------------------------------------------------------------

# Memoria per DSS: ROOT.war e' grosso, la validazione TSL/LOTL serve heap.
# Sovrascrivi via docker-compose se serve.
ENV CATALINA_OPTS="-Xms1g -Xmx2g -Djava.awt.headless=true"

EXPOSE 8080

# catalina.sh run = come startup.bat ma in foreground (richiesto da Docker)
CMD ["catalina.sh", "run"]
